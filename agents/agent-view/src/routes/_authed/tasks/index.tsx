import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchTasks, retryTask, cancelTask, continueTask } from '@/lib/api'
import { StatusBadge, OutcomeBadge } from '@/components/StatusBadge'
import { repoName, timeAgo, truncate, formatCost, formatTokens } from '@/lib/utils'

export const Route = createFileRoute('/_authed/tasks/')({
  loader: () => fetchTasks(),
  component: TasksPage,
})

function TasksPage() {
  const tasks = Route.useLoaderData()
  const router = useRouter()
  const [loadingAction, setLoadingAction] = useState<Record<string, string>>({})

  const withAction = async (taskId: string, action: string, fn: () => Promise<void>) => {
    setLoadingAction((prev) => ({ ...prev, [taskId]: action }))
    try {
      await fn()
    } finally {
      setLoadingAction((prev) => {
        const next = { ...prev }
        delete next[taskId]
        return next
      })
    }
  }

  const handleContinue = (task: (typeof tasks)[0]) =>
    withAction(task.id, 'continue', async () => {
      const result = await continueTask({ data: { taskId: task.id } })
      if (result.id && result.id !== task.id) {
        router.navigate({ to: '/tasks/$taskId', params: { taskId: result.id } })
      } else {
        router.invalidate()
      }
    })

  const handleRetry = (task: (typeof tasks)[0]) =>
    withAction(task.id, 'retry', async () => {
      const result = await retryTask({ data: { repo: task.repo, task: task.task, branch: task.branch } })
      if (result.id && !result.duplicate) {
        router.navigate({ to: '/tasks/$taskId', params: { taskId: result.id } })
      } else {
        router.invalidate()
      }
    })

  const handleCancel = (task: (typeof tasks)[0]) =>
    withAction(task.id, 'cancel', async () => {
      await cancelTask({ data: { taskId: task.id } })
      router.invalidate()
    })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Tasks</h1>
        <span className="text-sm text-gray-500">{tasks.length} total</span>
      </div>

      <div className="space-y-2">
        {tasks.map((task) => {
          const busy = loadingAction[task.id]
          const isFailed = task.status === 'failed' || task.status === 'cancelled'
          const isActive = task.status === 'running' || task.status === 'pending'
          const hasActions = isFailed || isActive || !!task.prUrl

          return (
            <Link
              key={task.id}
              to="/tasks/$taskId"
              params={{ taskId: task.id }}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors no-underline"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <code className="text-xs text-gray-500 font-mono break-all">{task.id}</code>
                    <StatusBadge status={task.status} />
                    {task.outcome && <OutcomeBadge outcome={task.outcome} />}
                  </div>
                  <p className="text-sm text-gray-200 mb-1">{truncate(task.task, 120)}</p>
                  <div className="flex items-center gap-x-3 gap-y-1 text-xs text-gray-500 flex-wrap">
                    <span className="font-medium text-gray-400">{repoName(task.repo)}</span>
                    <span>{timeAgo(task.createdAt)}</span>
                    {task.step && <span className="text-gray-600">step: {task.step}</span>}
                    {task.usage && (
                      <span className="text-amber-400/70">
                        {formatCost(task.usage.costUsd)} · {formatTokens(task.usage.inputTokens + task.usage.outputTokens)} tokens
                      </span>
                    )}
                  </div>
                </div>
                {hasActions && (
                  <div className="flex items-center gap-2 flex-wrap" onClick={(e) => e.preventDefault()}>
                    {isFailed && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleContinue(task) }}
                          disabled={!!busy}
                          className="px-3 py-1.5 bg-amber-600/80 hover:bg-amber-500 disabled:bg-gray-700 text-white text-xs rounded transition-colors cursor-pointer"
                        >
                          {busy === 'continue' ? '...' : 'Continue'}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRetry(task) }}
                          disabled={!!busy}
                          className="px-3 py-1.5 bg-cyan-600/80 hover:bg-cyan-500 disabled:bg-gray-700 text-white text-xs rounded transition-colors cursor-pointer"
                        >
                          {busy === 'retry' ? '...' : 'Retry'}
                        </button>
                      </>
                    )}
                    {isActive && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCancel(task) }}
                        disabled={!!busy}
                        className="px-3 py-1.5 bg-red-600/80 hover:bg-red-500 disabled:bg-gray-700 text-white text-xs rounded transition-colors cursor-pointer"
                      >
                        {busy === 'cancel' ? '...' : 'Cancel'}
                      </button>
                    )}
                    {task.prUrl && (
                      <a
                        href={task.prUrl}
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

        {tasks.length === 0 && (
          <p className="text-gray-500 text-center py-12">No tasks yet.</p>
        )}
      </div>
    </div>
  )
}
