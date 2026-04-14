import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchPrompts, fetchPrompt, savePrompt, deletePrompt } from '@/lib/api'
import type { PromptMeta, PromptDetail } from '@/lib/types'

export const Route = createFileRoute('/_authed/prompts/')({
  loader: () => fetchPrompts(),
  component: PromptsPage,
})

function PromptsPage() {
  const prompts = Route.useLoaderData()
  const [selectedType, setSelectedType] = useState<string>('task')
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [prompt, setPrompt] = useState<PromptDetail | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const loadPrompt = async (type: string, repo?: string) => {
    setLoading(true)
    setMessage('')
    try {
      const data = await fetchPrompt({ data: { type, repo: repo || undefined } })
      setPrompt(data)
      setEditContent(data.content)
      setSelectedType(type)
      setSelectedRepo(repo ?? '')
      setEditing(false)
    } catch (err) {
      setMessage('Failed to load prompt')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setLoading(true)
    setMessage('')
    try {
      await savePrompt({ data: { type: selectedType, content: editContent, repo: selectedRepo || undefined } })
      setMessage('Saved!')
      setEditing(false)
      await loadPrompt(selectedType, selectedRepo)
    } catch {
      setMessage('Failed to save')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Delete this prompt? Will fall back to the built-in default.')) return
    setLoading(true)
    try {
      await deletePrompt({ data: { type: selectedType, repo: selectedRepo || undefined } })
      setMessage('Deleted')
      setPrompt(null)
      setEditContent('')
    } catch {
      setMessage('Failed to delete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Prompts</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">System Prompts</h3>

            <div className="space-y-1">
              {(['task', 'plan'] as const).map((type) => {
                const repoVariants = prompts.filter((p: PromptMeta) => p.type === type && p.scope !== 'default')
                return (
                  <div key={type}>
                    <button
                      onClick={() => loadPrompt(type)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${
                        selectedType === type && !selectedRepo
                          ? 'bg-cyan-500/15 text-cyan-300'
                          : 'text-gray-400 hover:bg-gray-800'
                      }`}
                    >
                      <span className="font-medium capitalize">{type}</span>
                    </button>
                    {repoVariants.map((p: PromptMeta) => (
                      <button
                        key={p.key}
                        onClick={() => loadPrompt(p.type, p.scope)}
                        className={`w-full text-left px-3 py-1.5 pl-6 rounded text-xs transition-colors cursor-pointer ${
                          selectedType === p.type && selectedRepo === p.scope
                            ? 'bg-cyan-500/15 text-cyan-300'
                            : 'text-gray-500 hover:bg-gray-800'
                        }`}
                      >
                        <span className="text-gray-600">{p.scope}</span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          {prompt ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-white capitalize">{selectedType} prompt</h3>
                  {selectedRepo && (
                    <span className="text-xs text-gray-500 break-words">{selectedRepo}</span>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap shrink-0">
                  {!editing ? (
                    <button
                      onClick={() => setEditing(true)}
                      className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded-lg transition-colors cursor-pointer"
                    >
                      Edit
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={handleSave}
                        disabled={loading}
                        className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-xs rounded-lg transition-colors cursor-pointer"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => { setEditing(false); setEditContent(prompt.content) }}
                        className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded-lg transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {prompt.source !== 'hardcoded' && (
                    <button
                      onClick={handleDelete}
                      disabled={loading}
                      className="px-3 py-1.5 bg-red-600/60 hover:bg-red-500 text-white text-xs rounded-lg transition-colors cursor-pointer"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {message && <p className="text-xs text-cyan-400 mb-2">{message}</p>}

              {editing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full h-[300px] sm:h-[500px] bg-gray-950 text-gray-300 text-xs font-mono p-3 rounded-lg border border-gray-800 resize-y focus:outline-none focus:border-cyan-500/50"
                />
              ) : (
                <pre className="bg-gray-950 text-gray-300 text-xs font-mono p-3 rounded-lg border border-gray-800 max-h-[300px] sm:max-h-[500px] overflow-auto whitespace-pre-wrap break-words">
                  {prompt.content}
                </pre>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 text-gray-600 text-sm">
              Select a prompt to view
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
