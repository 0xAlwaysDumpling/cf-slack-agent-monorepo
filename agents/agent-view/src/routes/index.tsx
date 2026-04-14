import { createFileRoute, redirect } from '@tanstack/react-router'
import { checkAuth } from '@/lib/api'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const { authenticated } = await checkAuth()
    if (!authenticated) throw redirect({ to: '/login' })
    throw redirect({ to: '/tasks' })
  },
  component: () => null,
})
