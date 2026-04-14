import { Link, useRouterState } from '@tanstack/react-router'
import { logoutAction } from '@/lib/api'

const NAV_ITEMS = [
  { to: '/tasks', label: 'Tasks', icon: '⚡' },
  { to: '/plans', label: 'Plans', icon: '📋' },
  { to: '/prompts', label: 'Prompts', icon: '💬' },
  { to: '/sessions', label: 'Sessions', icon: '📦' },
] as const

interface SidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { location } = useRouterState()

  const handleLogout = async () => {
    await logoutAction()
    window.location.href = '/login'
  }

  const navContent = (
    <>
      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <Link
          to="/tasks"
          onClick={onClose}
          className="flex items-center gap-2 text-white font-semibold text-lg no-underline"
        >
          <span className="text-cyan-400">⬡</span>
          Agent View
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            className="md:hidden text-gray-400 hover:text-gray-200 p-1 -mr-1 cursor-pointer"
            aria-label="Close menu"
          >
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {NAV_ITEMS.map(({ to, label, icon }) => {
          const active = location.pathname.startsWith(to)
          return (
            <Link
              key={to}
              to={to}
              onClick={onClose}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors no-underline ${
                active
                  ? 'bg-cyan-500/15 text-cyan-300'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              <span>{icon}</span>
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="p-3 border-t border-gray-800">
        <button
          onClick={handleLogout}
          className="w-full px-3 py-2.5 text-sm text-gray-400 hover:text-red-300 hover:bg-gray-800 rounded-lg transition-colors text-left cursor-pointer"
        >
          Sign out
        </button>
      </div>
    </>
  )

  return (
    <>
      {/* Desktop sidebar — always visible on md+ */}
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 bg-gray-900 border-r border-gray-800 min-h-screen">
        {navContent}
      </aside>

      {/* Mobile drawer overlay */}
      {isOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={onClose}
            aria-hidden="true"
          />
          <aside className="relative z-10 flex flex-col w-64 max-w-[80vw] bg-gray-900 border-r border-gray-800 min-h-screen">
            {navContent}
          </aside>
        </div>
      )}
    </>
  )
}
