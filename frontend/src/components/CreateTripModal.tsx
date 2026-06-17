import { useState } from 'react'
import { X } from 'lucide-react'
import { api, type CreateTripPayload } from '../api/client'

interface Props {
  onClose: () => void
  onCreated: () => void
}

export function CreateTripModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<CreateTripPayload>({
    name: '',
    drive_folder_url: '',
    expected_member_count: undefined,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api.trips.create(form)
      onCreated()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create trip')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-white font-semibold text-lg">New Trip</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-zinc-400 text-sm mb-1.5">Trip name</label>
            <input
              required
              type="text"
              placeholder="Goa Dec 2025"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-500 text-sm focus:outline-none focus:border-violet-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-zinc-400 text-sm mb-1.5">Google Drive folder URL</label>
            <input
              required
              type="text"
              placeholder="https://drive.google.com/drive/folders/..."
              value={form.drive_folder_url}
              onChange={(e) => setForm((f) => ({ ...f, drive_folder_url: e.target.value }))}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-500 text-sm focus:outline-none focus:border-violet-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-zinc-400 text-sm mb-1.5">
              Expected group size <span className="text-zinc-600">(optional)</span>
            </label>
            <input
              type="number"
              min={1}
              max={50}
              placeholder="12"
              value={form.expected_member_count ?? ''}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  expected_member_count: e.target.value ? parseInt(e.target.value) : undefined,
                }))
              }
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-500 text-sm focus:outline-none focus:border-violet-500 transition-colors"
            />
            <p className="text-zinc-600 text-xs mt-1.5">
              Used to track enrollment coverage — how many of the group have been identified.
            </p>
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-lg border border-zinc-700 text-zinc-300 text-sm hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {loading ? 'Creating…' : 'Create Trip'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
