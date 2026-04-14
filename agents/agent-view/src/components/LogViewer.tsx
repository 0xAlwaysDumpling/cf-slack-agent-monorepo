import { useState, useMemo } from 'react'

interface ParsedEntry {
  type: 'init' | 'assistant' | 'tool_result' | 'result' | 'unknown'
  timestamp?: string
  data: Record<string, unknown>
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: Record<string, unknown>
  id?: string
}

function parseLogEntries(logs: string): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  for (const line of logs.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj.type === 'system' && obj.subtype === 'init') {
        entries.push({ type: 'init', data: obj })
      } else if (obj.type === 'assistant') {
        entries.push({ type: 'assistant', timestamp: obj.timestamp, data: obj })
      } else if (obj.type === 'user') {
        entries.push({ type: 'tool_result', timestamp: obj.timestamp, data: obj })
      } else if (obj.type === 'result') {
        entries.push({ type: 'result', data: obj })
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return entries
}

function formatTime(ts?: string): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return '' }
}

function InitEntry({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">{data.model as string}</span>
      <span className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded">v{data.claude_code_version as string}</span>
      <span className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded">{data.permissionMode as string}</span>
      <span className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded font-mono">{data.cwd as string}</span>
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const preview = text.slice(0, 120).replace(/\n/g, ' ')
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 cursor-pointer"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="italic">{open ? 'Thinking' : preview + (text.length > 120 ? '...' : '')}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-4 text-xs text-gray-500 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  )
}

function ToolCallBlock({ name, input }: { name: string; input?: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const summary = name === 'Read' || name === 'Glob' || name === 'Grep'
    ? (input?.file_path ?? input?.path ?? input?.pattern ?? input?.glob_pattern ?? '') as string
    : name === 'Bash' || name === 'Shell'
      ? (input?.command as string)?.slice(0, 100) ?? ''
      : name === 'Write' || name === 'Edit'
        ? (input?.file_path ?? input?.path ?? '') as string
        : ''

  return (
    <div className="mt-1.5 border-l-2 border-cyan-500/30 pl-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs cursor-pointer hover:opacity-80 min-w-0 w-full"
      >
        <span className="px-1.5 py-0.5 bg-cyan-500/20 text-cyan-300 rounded font-medium shrink-0">{name}</span>
        {summary && <span className="text-gray-500 font-mono truncate min-w-0">{summary}</span>}
      </button>
      {open && input && (
        <pre className="mt-1 text-xs text-gray-500 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  )
}

function ToolResultBlock({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const result = data.tool_use_result as Record<string, unknown> | undefined
  const file = result?.file as Record<string, unknown> | undefined
  const filePath = file?.filePath as string | undefined
  const numLines = file?.numLines as number | undefined

  if (!result) return null

  return (
    <div className="mt-1 border-l-2 border-gray-700 pl-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs cursor-pointer hover:opacity-80"
      >
        <span className="text-gray-600">↳</span>
        {filePath ? (
          <span className="text-gray-400 font-mono">{filePath} <span className="text-gray-600">({numLines} lines)</span></span>
        ) : (
          <span className="text-gray-500">result</span>
        )}
      </button>
      {open && (
        <pre className="mt-1 text-xs text-gray-500 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2).slice(0, 3000)}
        </pre>
      )}
    </div>
  )
}

function AssistantEntry({ data }: { data: Record<string, unknown> }) {
  const message = data.message as Record<string, unknown> | undefined
  const content = (message?.content ?? []) as ContentBlock[]

  return (
    <div className="space-y-1">
      {content.map((block, i) => {
        if (block.type === 'thinking' && block.thinking) {
          return <ThinkingBlock key={i} text={block.thinking} />
        }
        if (block.type === 'text' && block.text) {
          return (
            <div key={i} className="text-sm text-gray-200 whitespace-pre-wrap break-words">
              {block.text}
            </div>
          )
        }
        if (block.type === 'tool_use' && block.name) {
          return <ToolCallBlock key={i} name={block.name} input={block.input} />
        }
        return null
      })}
    </div>
  )
}

function ResultEntry({ data }: { data: Record<string, unknown> }) {
  const cost = data.total_cost_usd as number | undefined
  const input = data.total_input_tokens as number | undefined
  const output = data.total_output_tokens as number | undefined
  const turns = data.num_turns as number | undefined
  const duration = data.duration_ms as number | undefined
  const result = data.result as string | undefined

  return (
    <div className="space-y-2">
      {result && (
        <div className="text-sm text-gray-200 whitespace-pre-wrap break-words">
          {result.slice(0, 2000)}{result.length > 2000 ? '...' : ''}
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-xs">
        {input != null && <span className="text-gray-400"><span className="text-gray-600">in:</span> {input.toLocaleString()}</span>}
        {output != null && <span className="text-gray-400"><span className="text-gray-600">out:</span> {output.toLocaleString()}</span>}
        {cost != null && <span className="text-amber-400">${cost.toFixed(4)}</span>}
        {turns != null && <span className="text-gray-400"><span className="text-gray-600">turns:</span> {turns}</span>}
        {duration != null && <span className="text-gray-400"><span className="text-gray-600">duration:</span> {(duration / 1000).toFixed(1)}s</span>}
      </div>
    </div>
  )
}

function ParsedView({ entries }: { entries: ParsedEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-gray-500 italic text-sm">No parseable log entries found.</p>
  }

  const LABEL: Record<string, { text: string; color: string }> = {
    init: { text: 'INIT', color: 'bg-purple-500/20 text-purple-300' },
    assistant: { text: 'CLAUDE', color: 'bg-blue-500/20 text-blue-300' },
    tool_result: { text: 'RESULT', color: 'bg-gray-600/30 text-gray-400' },
    result: { text: 'DONE', color: 'bg-green-500/20 text-green-300' },
    unknown: { text: '?', color: 'bg-gray-700 text-gray-400' },
  }

  return (
    <div className="space-y-3 max-h-[500px] sm:max-h-[600px] overflow-y-auto overflow-x-hidden">
      {entries.map((entry, i) => {
        const label = LABEL[entry.type]
        return (
          <div key={i} className="flex gap-2 sm:gap-3 text-sm min-w-0">
            <div className="shrink-0 pt-0.5 flex flex-col items-end gap-0.5 w-14 sm:w-16">
              <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${label.color}`}>{label.text}</span>
              {entry.timestamp && <span className="text-[10px] text-gray-600 font-mono">{formatTime(entry.timestamp)}</span>}
            </div>
            <div className="flex-1 min-w-0">
              {entry.type === 'init' && <InitEntry data={entry.data} />}
              {entry.type === 'assistant' && <AssistantEntry data={entry.data} />}
              {entry.type === 'tool_result' && <ToolResultBlock data={entry.data} />}
              {entry.type === 'result' && <ResultEntry data={entry.data} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function LogViewer({ logs }: { logs: string }) {
  const [mode, setMode] = useState<'parsed' | 'raw'>('parsed')
  const entries = useMemo(() => parseLogEntries(logs), [logs])
  const hasParsed = entries.length > 0

  if (!logs?.trim()) {
    return <p className="text-gray-500 italic text-sm">No logs available.</p>
  }

  return (
    <div>
      <div className="flex gap-1 mb-3">
        {hasParsed && (
          <button
            onClick={() => setMode('parsed')}
            className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer ${
              mode === 'parsed' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Parsed
          </button>
        )}
        <button
          onClick={() => setMode('raw')}
          className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer ${
            mode === 'raw' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Raw
        </button>
      </div>

      {mode === 'parsed' && hasParsed ? (
        <ParsedView entries={entries} />
      ) : (
        <pre className="bg-gray-950 text-gray-300 text-xs leading-relaxed p-3 sm:p-4 rounded-lg overflow-x-auto max-h-[500px] sm:max-h-[600px] overflow-y-auto font-mono whitespace-pre-wrap break-words border border-gray-800">
          {logs}
        </pre>
      )}
    </div>
  )
}
