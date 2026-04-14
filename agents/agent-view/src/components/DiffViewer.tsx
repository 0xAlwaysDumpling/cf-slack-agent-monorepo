export function DiffViewer({ diff }: { diff: string }) {
  if (!diff?.trim()) {
    return <p className="text-gray-500 italic text-sm">No diff available.</p>
  }

  const lines = diff.split('\n')

  return (
    <pre className="bg-gray-950 text-xs leading-relaxed p-4 rounded-lg overflow-x-auto max-h-[600px] overflow-y-auto font-mono border border-gray-800">
      {lines.map((line, i) => {
        let cls = 'text-gray-400'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-green-400'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400'
        else if (line.startsWith('@@')) cls = 'text-cyan-400'
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-gray-500 font-bold'

        return (
          <div key={i} className={cls}>
            {line}
          </div>
        )
      })}
    </pre>
  )
}
