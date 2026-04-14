import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchSessions, retryTask, continueTask } from '@/lib/api'
import { StatusBadge, OutcomeBadge } from '@/components/StatusBadge'
import { repoName, timeAgo, formatCost, formatTokens } from '@/lib/utils'
import type { ArchivedSession } from '@/lib/types'

export const Route = createFileRoute('/_authed/sessions/')({
  loader: () => fetchSessions(),
  component: SessionsPage,
})

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

function SessionsPage() {
  const sessions = Route.useLoaderData()
  const router = useRouter()
  const [loadingAction, setLoadingAction] = useState<Record<string, string>>({})

  const withAction = async (id: string, action: string, fn: () => Promise<void>) => {
    setLoadingAction((prev) => ({ ...prev, [id]: action }))
    try {
      await fn()
    } finally {
      setLoadingAction((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  const handleContinue = (s: ArchivedSession) =>
    withAction(s.id, 'continue', async () => {
      const result = await continueTask({ data: { taskId: s.id } })
      if (result.id && result.id !== s.id) {
        router.navigate({ to: '/tasks/$taskId', params: { taskId: result.id } })
      } else {
        router.invalidate()
      }
    })

  const handleRetry = (s: ArchivedSession) =>
    withAction(s.id, 'retry', async () => {
      const result = await retryTask({ data: { repo: s.repo, task: s.task, branch: s.branch } })
      if (result.id && !result.duplicate) {
        router.navigate({ to: '/tasks/$taskId', params: { taskId: result.id } })
      } else {
        router.invalidate()
      }
    })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Sessions</h1>
        <span className="text-sm text-gray-500">{sessions.length} archived</span>
      </div>

      <div className="space-y-2">
        {sessions.map((s) => {
          const busy = loadingAction[s.id]
          const isFailed = s.status === 'failed' || s.status === 'cancelled'
          const hasActions = isFailed || !!s.prUrl

          return (
            <Link
              key={s.id}
              to="/tasks/$taskId"
              params={{ taskId: s.id }}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors no-underline"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <code className="text-xs text-gray-500 font-mono break-all">{s.id}</code>
                    <StatusBadge status={s.status} />
                    {s.outcome && <OutcomeBadge outcome={s.outcome} />}
                  </div>
                  <p className="text-sm text-gray-300 mb-1">{s.task}</p>
                  <div className="flex items-center gap-x-3 gap-y-1 text-xs text-gray-500 flex-wrap">
                    <span className="text-gray-400">{repoName(s.repo)}</span>
                    <span>{timeAgo(s.completedAt ?? s.createdAt)}</span>
                    {s.durationMs > 0 && (
                      <span className="text-gray-600">{formatDuration(s.durationMs)}</span>
                    )}
                    {s.usage && (
                      <span className="text-amber-400/70">
                        {formatCost(s.usage.costUsd)} · {formatTokens(s.usage.inputTokens + s.usage.outputTokens)} tokens
                      </span>
                    )}
                  </div>
                </div>
                {hasActions && (
                  <div className="flex items-center gap-2 flex-wrap" onClick={(e) => e.preventDefault()}>
                    {isFailed && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleContinue(s) }}
                          disabled={!!busy}
                          className="px-3 py-1.5 bg-amber-600/80 hover:bg-amber-500 disabled:bg-gray-700 text-white text-xs rounded transition-colors cursor-pointer"
                        >
                          {busy === 'continue' ? '...' : 'Continue'}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRetry(s) }}
                          disabled={!!busy}
                          className="px-3 py-1.5 bg-cyan-600/80 hover:bg-cyan-500 disabled:bg-gray-700 text-white text-xs rounded transition-colors cursor-pointer"
                        >
                          {busy === 'retry' ? '...' : 'Retry'}
                        </button>
                      </>
                    )}
                    {s.prUrl && (
                      <a
                        href={s.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="px-3 py-1.5 bg-green-500/10 text-green-400 text-xs rounded border border-green-500/20 hover:bg-green-500/20 transition-colors no-underline"
                      >
                        PR
                      </a>
                    )}
                  </div>
                )}
              </div>
            </Link>
          )
        })}

        {sessions.length === 0 && (
          <p className="text-gray-500 text-center py-12">No archived sessions yet.</p>
        )}
      </div>
    </div>
  )
}
