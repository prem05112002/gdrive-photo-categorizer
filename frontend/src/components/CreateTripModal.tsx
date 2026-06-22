import { useState } from 'react'
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
    /* Backdrop */
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        background: 'rgba(8,8,11,.55)', backdropFilter: 'blur(1px)',
      }}
    >
      {/* Modal card */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 400,
          background: '#1E1E2A', border: '1px solid var(--border)',
          borderRadius: 14, boxShadow: '0 20px 50px rgba(0,0,0,.6)',
          padding: 24,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 17, color: '#F4F4F5' }}>New Trip</div>
        <div style={{ fontSize: 12, color: '#71717A', marginTop: 4 }}>
          Point Focal at a shared Drive folder.
        </div>

        <form onSubmit={handleSubmit} style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Trip name" required>
            <Input
              type="text"
              placeholder="e.g. Goa 2026"
              required
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </Field>

          <Field label="Google Drive folder URL" required>
            <Input
              type="text"
              placeholder="drive.google.com/drive/folders/…"
              required
              value={form.drive_folder_url}
              onChange={e => setForm(f => ({ ...f, drive_folder_url: e.target.value }))}
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            />
          </Field>

          <Field label="Expected group size" optional>
            <Input
              type="number"
              min={1}
              max={50}
              placeholder="9"
              value={form.expected_member_count ?? ''}
              onChange={e => setForm(f => ({ ...f, expected_member_count: e.target.value ? parseInt(e.target.value) : undefined }))}
              style={{ width: 120 }}
            />
          </Field>

          {error && (
            <div style={{ fontSize: 13, color: '#fca5a5', background: 'rgba(69,10,10,0.4)', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{ background: 'transparent', color: '#a1a1aa', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
            >
              {loading ? 'Creating…' : 'Create Trip'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({ label, required, optional, children }: {
  label: string
  required?: boolean
  optional?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#a1a1aa', marginBottom: 6 }}>
        {label}
        {required && <span style={{ color: '#EF4444', marginLeft: 3 }}>*</span>}
        {optional && <span style={{ color: '#52525b', fontWeight: 400, marginLeft: 4 }}>(optional)</span>}
      </div>
      {children}
    </div>
  )
}

function Input({ style, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        height: 40, width: '100%', boxSizing: 'border-box',
        border: '1px solid var(--border)', borderRadius: 8,
        background: 'var(--surface)', color: '#52525b',
        padding: '0 12px', fontSize: 13, outline: 'none',
        ...style,
      }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--text-primary)' }}
      onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = '#52525b' }}
    />
  )
}
