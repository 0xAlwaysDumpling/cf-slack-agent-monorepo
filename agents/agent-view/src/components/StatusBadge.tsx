import type { TaskStatus, PlanStatus, PlanStepStatus, TaskOutcome } from '@/lib/types'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  running: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  completed: 'bg-green-500/20 text-green-300 border-green-500/30',
  failed: 'bg-red-500/20 text-red-300 border-red-500/30',
  cancelled: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  draft: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  skipped: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  merged: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
}

const OUTCOME_COLORS: Record<string, string> = {
  pr_created: 'bg-green-500/20 text-green-300 border-green-500/30',
  no_changes: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  error: 'bg-red-500/20 text-red-300 border-red-500/30',
  timeout: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  cancelled: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
}

export function StatusBadge({ status }: { status: TaskStatus | PlanStatus | PlanStepStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded border ${STATUS_COLORS[status] ?? STATUS_COLORS.pending}`}>
      {status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse mr-1.5" />}
      {status}
    </span>
  )
}

export function OutcomeBadge({ outcome }: { outcome: TaskOutcome }) {
  const label = outcome.replace(/_/g, ' ')
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded border ${OUTCOME_COLORS[outcome] ?? OUTCOME_COLORS.error}`}>
      {label}
    </span>
  )
}
