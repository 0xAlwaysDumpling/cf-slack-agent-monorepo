import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { fetchPlan, fetchTask, runPlan, resetPlan, deletePlan } from '@/lib/api'
import { StatusBadge } from '@/components/StatusBadge'
import { ModelSelectorModal } from '@/components/ModelSelectorModal'
import { repoName, timeAgo, formatTokens, formatCost } from '@/lib/utils'

const POLL_INTERVAL_MS = 5_000

export const Route = createFileRoute('/_authed/plans/$planId')({
  loader: async ({ params }) => {
    const plan = await fetchPlan({ data: { planId: params.planId } })
    const taskIds = (plan.steps ?? []).map((s) => s.taskId).filter(Boolean) as string[]
    const tasks = await Promise.all(
      taskIds.map((id) => fetchTask({ data: { taskId: id } }).catch(() => null))
    )
    const taskMap: Record<string, { usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }> = {}
    for (const t of tasks) {
      if (t?.id) taskMap[t.id] = t
    }
    return { plan, taskMap }
  },
  component: PlanDetailPage,
})

function PlanDetailPage() {
  const { plan, taskMap } = Route.useLoaderData()
  const router = useRouter()
  const [actionLoading, setActionLoading] = useState(false)
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (plan.status === 'running') {
      intervalRef.current = setInterval(() => router.invalidate(), POLL_INTERVAL_MS)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [plan.status, router])

  const handleRunClick = () => {
    setModelModalOpen(true)
  }

  const handleModelConfirm = async (modelProvider: 'anthropic' | 'fireworks') => {
    setModelModalOpen(false)
    setActionLoading(true)
    try {
      await runPlan({ data: { planId: plan.id, modelProvider } })
      router.invalidate()
    } finally {
      setActionLoading(false)
    }
  }

  const handleReset = async () => {
    setActionLoading(true)
    try {
      await resetPlan({ data: { planId: plan.id } })
      router.invalidate()
    } finally {
      setActionLoading(false)
    }
  }

  const handleDelete = async () => {
    setActionLoading(true)
    try {
      await deletePlan({ data: { planId: plan.id } })
      router.navigate({ to: '/plans' })
    } finally {
      setActionLoading(false)
    }
  }

  const steps = plan.steps ?? []
  const completed = steps.filter((s) => s.status === 'completed' || s.status === 'merged').length

  return (
    <div>
      <div className="mb-6">
        <Link to="/plans" className="text-sm text-gray-500 hover:text-gray-300 no-underline">
          &larr; Back to Plans
        </Link>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <code className="text-sm text-gray-400 font-mono break-all">{plan.id}</code>
              <StatusBadge status={plan.status} />
            </div>
            <h2 className="text-xl font-semibold text-white">{plan.name}</h2>
          </div>

          <div className="flex gap-2 flex-wrap shrink-0">
            {plan.status === 'draft' && (
              <button
                onClick={handleRunClick}
                disabled={actionLoading}
                className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors cursor-pointer"
              >
                {actionLoading ? '...' : 'Run Plan'}
              </button>
            )}
            {plan.status === 'failed' && (
              <button
                onClick={handleReset}
                disabled={actionLoading}
                className="px-3 py-1.5 bg-yellow-600/80 hover:bg-yellow-500 disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors cursor-pointer"
              >
                {actionLoading ? '...' : 'Reset'}
              </button>
            )}
            {plan.status === 'running' && (
              <button
                onClick={() => router.invalidate()}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors cursor-pointer"
              >
                Refresh
              </button>
            )}
            <button
              onClick={handleDelete}
              disabled={actionLoading}
              className="px-3 py-1.5 bg-red-600/80 hover:bg-red-500 disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors cursor-pointer"
            >
              {actionLoading ? '...' : 'Delete'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-4">
          <div>
            <span className="text-gray-500 block text-xs mb-0.5">Repo</span>
            <a href={plan.repo} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 no-underline break-words">
              {repoName(plan.repo)}
            </a>
          </div>
          <div>
            <span className="text-gray-500 block text-xs mb-0.5">Branch</span>
            <span className="text-gray-300 font-mono text-xs break-all">{plan.branch}</span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs mb-0.5">Progress</span>
            <span className="text-gray-300">{completed} / {steps.length}</span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs mb-0.5">Created</span>
            <span className="text-gray-300">{timeAgo(plan.createdAt)}</span>
          </div>
        </div>

        {plan.error && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
            <span className="text-xs text-red-400 font-medium">Error</span>
            <p className="text-sm text-red-300 mt-1 break-words">{plan.error}</p>
          </div>
        )}

        <div className="mt-4 w-full h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-cyan-500 rounded-full transition-all"
            style={{ width: steps.length > 0 ? `${(completed / steps.length) * 100}%` : '0%' }}
          />
        </div>
      </div>

      <h3 className="text-lg font-semibold text-white mb-3">Steps</h3>
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div
            key={step.id}
            className={`bg-gray-900 border rounded-lg p-4 ${
              step.status === 'running' ? 'border-blue-500/40' : 'border-gray-800'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <span className="text-xs text-gray-600 font-mono mt-0.5 shrink-0 w-5 text-right">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <StatusBadge status={step.status} />
                    {step.taskId && (
                      <Link
                        to="/tasks/$taskId"
                        params={{ taskId: step.taskId }}
                        className="text-xs text-gray-500 hover:text-cyan-400 font-mono no-underline break-all"
                      >
                        {step.taskId}
                      </Link>
                    )}
                  </div>
                  <p className="text-sm text-gray-300">{step.description}</p>
                </div>
              </div>

              {step.prUrl && (
                <a
                  href={step.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 px-2 py-1 bg-green-500/10 text-green-400 text-xs rounded border border-green-500/20 hover:bg-green-500/20 transition-colors no-underline"
                >
                  PR #{step.prNumber}
                </a>
              )}
            </div>
            {step.taskId && taskMap[step.taskId]?.usage && (() => {
              const u = taskMap[step.taskId]!.usage!
              const hasTokens = (u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0
              if (!hasTokens && !u.costUsd) return null
              return (
                <div className="flex items-center gap-3 mt-2 ml-8 text-xs text-gray-500">
                  {hasTokens && (
                    <span>{formatTokens(u.inputTokens ?? 0)} in · {formatTokens(u.outputTokens ?? 0)} out</span>
                  )}
                  {u.costUsd != null && u.costUsd > 0 && (
                    <span>{formatCost(u.costUsd)}</span>
                  )}
                </div>
              )
            })()}
          </div>
        ))}
      </div>

      <ModelSelectorModal
        open={modelModalOpen}
        context="run-plan"
        onConfirm={handleModelConfirm}
        onCancel={() => setModelModalOpen(false)}
        isLoading={actionLoading}
      />
    </div>
  )
}
