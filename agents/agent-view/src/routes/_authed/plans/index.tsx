import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchPlans, deletePlan } from '@/lib/api'
import { StatusBadge } from '@/components/StatusBadge'
import { repoName, timeAgo } from '@/lib/utils'

export const Route = createFileRoute('/_authed/plans/')({
  loader: () => fetchPlans(),
  component: PlansPage,
})

function PlansPage() {
  const plans = Route.useLoaderData()
  const router = useRouter()
  const [loadingAction, setLoadingAction] = useState<Record<string, boolean>>({})

  const handleDelete = async (planId: string) => {
    setLoadingAction((prev) => ({ ...prev, [planId]: true }))
    try {
      await deletePlan({ data: { planId } })
      router.invalidate()
    } finally {
      setLoadingAction((prev) => {
        const next = { ...prev }
        delete next[planId]
        return next
      })
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Plans</h1>
        <span className="text-sm text-gray-500">{plans.length} total</span>
      </div>

      <div className="space-y-2">
        {plans.map((plan) => {
          const steps = plan.steps ?? []
          const completed = steps.filter((s) => s.status === 'completed' || s.status === 'merged').length
          const total = steps.length
          const busy = loadingAction[plan.id]
          return (
            <Link
              key={plan.id}
              to="/plans/$planId"
              params={{ planId: plan.id }}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors no-underline"
            >
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <code className="text-xs text-gray-500 font-mono break-all">{plan.id}</code>
                <StatusBadge status={plan.status} />
              </div>
              <p className="text-sm font-medium text-gray-200 mb-2">{plan.name}</p>
              <div className="flex items-center gap-x-3 gap-y-1 text-xs text-gray-500 mb-3 flex-wrap">
                <span className="font-medium text-gray-400">{repoName(plan.repo)}</span>
                <span>{completed}/{total} steps</span>
                <span>{timeAgo(plan.createdAt)}</span>
              </div>
              <div className="flex items-center gap-3" onClick={(e) => e.preventDefault()}>
                <div className="flex-1">
                  <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-cyan-500 rounded-full transition-all"
                      style={{ width: total > 0 ? `${(completed / total) * 100}%` : '0%' }}
                    />
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(plan.id) }}
                  disabled={busy}
                  className="px-3 py-1.5 bg-red-600/80 hover:bg-red-500 disabled:bg-gray-700 text-white text-xs rounded transition-colors cursor-pointer shrink-0"
                >
                  {busy ? '...' : 'Delete'}
                </button>
              </div>
            </Link>
          )
        })}

        {plans.length === 0 && (
          <p className="text-gray-500 text-center py-12">No plans yet.</p>
        )}
      </div>
    </div>
  )
}
