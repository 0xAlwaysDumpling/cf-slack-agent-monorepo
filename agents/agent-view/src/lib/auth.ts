import { getCookie, setCookie, deleteCookie } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'

const COOKIE_NAME = 'agent-view-auth'

export function isAuthenticated(): boolean {
  try {
    return getCookie(COOKIE_NAME) === 'authenticated'
  } catch {
    return false
  }
}

export function checkPassword(password: string): boolean {
  return password === (env.AUTH_PASSWORD as string)
}

export function setAuthCookie(): void {
  setCookie(COOKIE_NAME, 'authenticated', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
}

export function clearAuthCookie(): void {
  deleteCookie(COOKIE_NAME, { path: '/' })
}
