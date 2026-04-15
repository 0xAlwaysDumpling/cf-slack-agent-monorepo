export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type TaskOutcome = 'pr_created' | 'no_changes' | 'error' | 'timeout' | 'cancelled'
export type PlanStatus = 'draft' | 'running' | 'completed' | 'failed'
export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'merged'

export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd: number
  numTurns: number
  durationMs?: number
}

export interface TaskResult {
  id: string
  status: TaskStatus
  repo: string
  task: string
  branch: string
  createdAt: string
  updatedAt: string
  step?: string
  logs?: string
  diff?: string
  prUrl?: string
  error?: string
  summary?: string
  outcome?: TaskOutcome
  usage?: TaskUsage
  priorTaskId?: string
  duplicate?: boolean
  modelProvider?: 'anthropic' | 'fireworks'
}

export interface PlanStep {
  id: string
  description: string
  taskId?: string
  branchName?: string
  prUrl?: string
  prNumber?: number
  status: PlanStepStatus
}

export interface PlanResult {
  id: string
  repo: string
  name: string
  steps: PlanStep[]
  status: PlanStatus
  branch: string
  currentStepIndex: number
  createdAt: string
  updatedAt: string
  error?: string
  modelProvider?: 'anthropic' | 'fireworks'
}

export interface ArchivedSession {
  id: string
  repo: string
  task: string
  branch: string
  branchName?: string
  status: TaskStatus
  outcome?: TaskOutcome
  planId?: string
  createdAt: string
  completedAt: string
  durationMs: number
  step?: string
  summary?: string
  diff?: string
  prUrl?: string
  logs?: string
  error?: string
  usage?: TaskUsage
}

export interface PromptMeta {
  key: string
  type: string
  scope: string
  size: number
  updatedAt: string
}

export interface PromptDetail {
  type: string
  repo: string | null
  source: 'repo' | 'default' | 'hardcoded'
  content: string
}

export interface RepoConfig {
  repoUrl: string
  platform: 'railway' | 'cloudflare-workers' | 'generic'
  defaultBranch: string
  branchPrefix: string
  systemPromptOverride?: string
}
