import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { fetchTask, fetchTaskLogs, fetchTaskSession, retryTask, cancelTask, continueTask } from '@/lib/api'
import { StatusBadge, OutcomeBadge } from '@/components/StatusBadge'
import { LogViewer } from '@/components/LogViewer'
import { DiffViewer } from '@/components/DiffViewer'
import { ModelSelectorModal } from '@/components/ModelSelectorModal'
import { repoName, timeAgo, formatDuration, formatTokens, formatCost } from '@/lib/utils'

const POLL_INTERVAL_MS = 5_000

export const Route = createFileRoute('/_authed/tasks/$taskId')({
  loader: async ({ params }) => {
    const [task, logsData, session] = await Promise.all([
      fetchTask({ data: { taskId: params.taskId } }),
      fetchTaskLogs({ data: { taskId: params.taskId } }).catch(() => ({ logs: '' })),
      fetchTaskSession({ data: { taskId: params.taskId } }).catch(() => null),
    ])
    return { task, logs: logsData.logs, session }
  },
  component: TaskDetailPage,
})

function TaskDetailPage() {
  const { task, logs, session } = Route.useLoaderData()
  const router = useRouter()
  const [tab, setTab] = useState<'summary' | 'logs' | 'diff'>('summary')
  const [actionLoading, setActionLoading] = useState(false)
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<'retry' | 'run' | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isActive = task.status === 'running' || task.status === 'pending'

  useEffect(() => {
    if (isActive) {
      intervalRef.current = setInterval(() => router.invalidate(), POLL_INTERVAL_MS)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isActive, router])

  const handleRetryClick = () => {
    setPendingAction('retry')
    setModelModalOpen(true)
  }

  const handleRunClick = () => {
    setPendingAction('run')
    setModelModalOpen(true)
  }

  const handleModelConfirm = async (modelProvider: 'anthropic' | 'fireworks') => {
    setModelModalOpen(false)
    setActionLoading(true)
    try {
      const result = await retryTask({ data: { repo: task.repo, task: task.task, branch: task.branch, modelProvider } })
      if (result.id && !result.duplicate) {
        router.navigate({ to: '/tasks/$taskId', params: { taskId: result.id } })
      } else {
        router.invalidate()
      }
    } finally {
      setActionLoading(false)
      setPendingAction(null)
    }
  }

  const handleContinue = async () => {
    setActionLoading(true)
    try {
      const result = await continueTask({ data: { taskId: task.id } })
      if (result.id && result.id !== task.id) {
        router.navigate({ to: '/tasks/$taskId', params: { taskId: result.id } })
      } else {
        router.invalidate()
      }
    } finally {
      setActionLoading(false)
    }
  }

  const handleCancel = async () => {
    setActionLoading(true)
    try {
      await cancelTask({ data: { taskId: task.id } })
      router.invalidate()
    } finally {
      setActionLoading(false)
    }
  }

  const diff = session?.diff ?? task.diff ?? ''
  const summary = session?.summary ?? task.summary ?? ''
  const usage = session?.usage ?? task.usage
  const duration = usage?.durationMs
    ? formatDuration(usage.durationMs)
    : session?.durationMs
      ? formatDuration(session.durationMs)
      : timeAgo(task.createdAt)

  return (
    <div>
      <div className="mb-6">
        <Link to="/tasks" className="text-sm text-gray-500 hover:text-gray-300 no-underline">
          &larr; Back to Tasks
        </Link>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <code className="text-sm text-gray-400 font-mono break-all">{task.id}</code>
              <StatusBadge status={task.status} />
              {task.outcome && <OutcomeBadge outcome={task.outcome} />}
            </div>
            <p className="text-gray-200">{task.task}</p>
            {task.priorTaskId && (
              <Link
                to="/tasks/$taskId"
                params={{ taskId: task.priorTaskId }}
                className="text-xs text-amber-400/70 hover:text-amber-300 no-underline mt-1 inline-block"
              >
                Continued from {task.priorTaskId}
              </Link>
            )}
          </div>

          <div className="flex gap-2 flex-wrap shrink-0">
            {(task.status === 'failed' || task.status === 'cancelled') && (
              <>
                <button
                  onClick={handleContinue}
                  disabled={actionLoading}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors cursor-pointer"
                >
                  {actionLoading ? '...' : 'Continue'}
                </button>
                <button
                  onClick={handleRetryClick}
                  disabled={actionLoading}
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors cursor-pointer"
                >
                  {actionLoading ? '...' : 'Retry'}
                </button>
                <button
                  onClick={handleRunClick}
                  disabled={actionLoading}
                  className="px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors cursor-pointer"
                >
                  {actionLoading ? '...' : 'Run'}
                </button>
              </>
            )}
            {(task.status === 'running' || task.status === 'pending') && (
              <button
                onClick={handleCancel}
                disabled={actionLoading}
                className="px-3 py-1.5 bg-red-600/80 hover:bg-red-500 disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors cursor-pointer"
              >
                {actionLoading ? '...' : 'Cancel'}
              </button>
            )}
            {task.status === 'running' && (
              <button
                onClick={() => router.invalidate()}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors cursor-pointer"
              >
                Refresh
              </button>
            )}
            {task.status === 'completed' && (
              <button
                onClick={handleRunClick}
                disabled={actionLoading}
                className="px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors cursor-pointer"
              >
                {actionLoading ? '...' : 'Run'}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500 block text-xs mb-0.5">Repo</span>
            <a
              href={task.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 hover:text-cyan-300 no-underline break-words"
            >
              {repoName(task.repo)}
            </a>
          </div>
          <div>
            <span className="text-gray-500 block text-xs mb-0.5">Branch</span>
            <span className="text-gray-300 font-mono text-xs break-all">{task.branch}</span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs mb-0.5">Duration</span>
            <span className="text-gray-300">{duration}</span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs mb-0.5">Step</span>
            <span className="text-gray-300">{task.step ?? '—'}</span>
          </div>
        </div>

        {usage && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm border-t border-gray-800 pt-4">
            <div>
              <span className="text-gray-500 block text-xs mb-0.5">Tokens In</span>
              <span className="text-gray-300 font-mono">{formatTokens(usage.inputTokens)}</span>
              {usage.cacheReadTokens ? (
                <span className="text-gray-500 text-xs ml-1">({formatTokens(usage.cacheReadTokens)} cached)</span>
              ) : null}
            </div>
            <div>
              <span className="text-gray-500 block text-xs mb-0.5">Tokens Out</span>
              <span className="text-gray-300 font-mono">{formatTokens(usage.outputTokens)}</span>
            </div>
            <div>
              <span className="text-gray-500 block text-xs mb-0.5">Cost</span>
              <span className="text-amber-400 font-mono">{formatCost(usage.costUsd)}</span>
            </div>
            <div>
              <span className="text-gray-500 block text-xs mb-0.5">Turns</span>
              <span className="text-gray-300 font-mono">{usage.numTurns}</span>
            </div>
          </div>
        )}

        {task.error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
            <span className="text-xs text-red-400 font-medium">Error</span>
            <p className="text-sm text-red-300 mt-1 break-words">{task.error}</p>
          </div>
        )}

        {task.prUrl && (
          <div className="mt-4">
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-500/10 text-green-400 text-sm rounded-lg border border-green-500/20 hover:bg-green-500/20 transition-colors no-underline"
            >
              View Pull Request &rarr;
            </a>
          </div>
        )}
      </div>

      <div className="border-b border-gray-800 mb-4">
        <nav className="flex gap-1">
          {(['summary', 'logs', 'diff'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
                tab === t
                  ? 'border-cyan-400 text-cyan-300'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'summary' && (
        <div className="prose prose-invert max-w-none">
          {summary ? (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-300 whitespace-pre-wrap break-words">
              {summary}
            </div>
          ) : (
            <p className="text-gray-500 italic text-sm">No summary available.</p>
          )}
        </div>
      )}
      {tab === 'logs' && <LogViewer logs={logs} />}
      {tab === 'diff' && <DiffViewer diff={diff} />}

      <ModelSelectorModal
        open={modelModalOpen}
        context={pendingAction === 'retry' ? 'retry-task' : 'run-task'}
        onConfirm={handleModelConfirm}
        onCancel={() => {
          setModelModalOpen(false)
          setPendingAction(null)
        }}
        isLoading={actionLoading}
      />
    </div>
  )
}
