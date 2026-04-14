import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchPlan, runPlan, resetPlan, deletePlan } from '@/lib/api'
import { StatusBadge } from '@/components/StatusBadge'
import { repoName, timeAgo } from '@/lib/utils'

export const Route = createFileRoute('/_authed/plans/$planId')({
  loader: ({ params }) => fetchPlan({ data: { planId: params.planId } }),
  component: PlanDetailPage,
})

function PlanDetailPage() {
  const plan = Route.useLoaderData()
  const router = useRouter()
  const [actionLoading, setActionLoading] = useState(false)

  const handleRun = async () => {
    setActionLoading(true)
    try {
      await runPlan({ data: { planId: plan.id } })
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
                onClick={handleRun}
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
          </div>
        ))}
      </div>
    </div>
  )
}
