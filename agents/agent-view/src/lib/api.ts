import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { isAuthenticated, checkPassword, setAuthCookie, clearAuthCookie } from './auth'
import type {
  TaskResult,
  PlanResult,
  ArchivedSession,
  PromptMeta,
  PromptDetail,
} from './types'

async function fetchAgent(path: string, init?: RequestInit): Promise<Response> {
  const service = (env as Record<string, unknown>).DEV_AGENT as { fetch: typeof fetch } | undefined
  if (service) {
    return service.fetch(new Request(`https://dev-agent${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    }))
  }
  const baseUrl = env.DEV_AGENT_URL as string
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
}

function requireAuth() {
  if (!isAuthenticated()) throw new Error('Unauthorized')
}

// ── Auth ──

export const checkAuth = createServerFn({ method: 'GET' })
  .handler(async () => {
    return { authenticated: isAuthenticated() }
  })

export const loginAction = createServerFn({ method: 'POST' })
  .inputValidator((d: { password: string }) => d)
  .handler(async ({ data }) => {
    if (!checkPassword(data.password)) return { success: false }
    setAuthCookie()
    return { success: true }
  })

export const logoutAction = createServerFn({ method: 'POST' })
  .handler(async () => {
    clearAuthCookie()
    return { success: true }
  })

// ── Tasks ──

export const fetchTasks = createServerFn({ method: 'GET' })
  .handler(async () => {
    requireAuth()
    const res = await fetchAgent('/tasks')
    const data = await res.json() as { tasks: TaskResult[] }
    return data.tasks.reverse()
  })

export const fetchTask = createServerFn({ method: 'GET' })
  .inputValidator((d: { taskId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/tasks/${data.taskId}`)
    return (await res.json()) as TaskResult
  })

export const fetchTaskLogs = createServerFn({ method: 'GET' })
  .inputValidator((d: { taskId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/tasks/${data.taskId}/logs`)
    return { logs: await res.text() }
  })

export const fetchTaskSession = createServerFn({ method: 'GET' })
  .inputValidator((d: { taskId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/tasks/${data.taskId}/session`)
    if (!res.ok) return null
    return (await res.json()) as ArchivedSession
  })

export const retryTask = createServerFn({ method: 'POST' })
  .inputValidator((d: { repo: string; task: string; branch?: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent('/tasks', {
      method: 'POST',
      body: JSON.stringify({ repo: data.repo, task: data.task, branch: data.branch }),
    })
    return (await res.json()) as TaskResult
  })

export const cancelTask = createServerFn({ method: 'POST' })
  .inputValidator((d: { taskId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/tasks/${data.taskId}/cancel`, { method: 'POST' })
    return (await res.json()) as TaskResult
  })

export const continueTask = createServerFn({ method: 'POST' })
  .inputValidator((d: { taskId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/tasks/${data.taskId}/continue`, { method: 'POST' })
    return (await res.json()) as TaskResult
  })

// ── Sessions (R2 archive) ──

export const fetchSessions = createServerFn({ method: 'GET' })
  .handler(async () => {
    requireAuth()
    const res = await fetchAgent('/sessions')
    const data = await res.json() as { sessions: ArchivedSession[] }
    return data.sessions
  })

// ── Plans ──

export const fetchPlans = createServerFn({ method: 'GET' })
  .handler(async () => {
    requireAuth()
    const res = await fetchAgent('/plans')
    const data = await res.json() as { plans: PlanResult[] }
    return data.plans.reverse()
  })

export const fetchPlan = createServerFn({ method: 'GET' })
  .inputValidator((d: { planId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/plans/${data.planId}`)
    return (await res.json()) as PlanResult
  })

export const runPlan = createServerFn({ method: 'POST' })
  .inputValidator((d: { planId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/plans/${data.planId}/run`, { method: 'POST' })
    return (await res.json()) as PlanResult
  })

export const resetPlan = createServerFn({ method: 'POST' })
  .inputValidator((d: { planId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/plans/${data.planId}/reset`, { method: 'POST' })
    return (await res.json()) as PlanResult
  })

export const deletePlan = createServerFn({ method: 'POST' })
  .inputValidator((d: { planId: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/plans/${data.planId}`, { method: 'DELETE' })
    return (await res.json()) as { ok: boolean }
  })

// ── Prompts ──

export const fetchPrompts = createServerFn({ method: 'GET' })
  .handler(async () => {
    requireAuth()
    const res = await fetchAgent('/prompts')
    const data = await res.json() as { prompts: PromptMeta[] }
    return data.prompts
  })

export const fetchPrompt = createServerFn({ method: 'GET' })
  .inputValidator((d: { type: string; repo?: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const qs = data.repo ? `?repo=${encodeURIComponent(data.repo)}` : ''
    const res = await fetchAgent(`/prompts/${data.type}${qs}`)
    return (await res.json()) as PromptDetail
  })

export const savePrompt = createServerFn({ method: 'POST' })
  .inputValidator((d: { type: string; content: string; repo?: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const res = await fetchAgent(`/prompts/${data.type}`, {
      method: 'PUT',
      body: JSON.stringify({ content: data.content, repo: data.repo }),
    })
    return (await res.json()) as { ok: boolean }
  })

export const deletePrompt = createServerFn({ method: 'POST' })
  .inputValidator((d: { type: string; repo?: string }) => d)
  .handler(async ({ data }) => {
    requireAuth()
    const qs = data.repo ? `?repo=${encodeURIComponent(data.repo)}` : ''
    const res = await fetchAgent(`/prompts/${data.type}${qs}`, { method: 'DELETE' })
    return (await res.json()) as { ok: boolean }
  })
