import { useState, useEffect } from 'react'
import { ServerCrash } from 'lucide-react'
import { api, type Trip } from '../api/client'
import { TripCard } from '../components/TripCard'
import { CreateTripModal } from '../components/CreateTripModal'
import { Topbar, NewTripButton } from '../components/Topbar'

export function Home() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [backendOffline, setBackendOffline] = useState(false)

  async function loadTrips() {
    try {
      const data = await api.trips.list()
      setTrips(data)
      setBackendOffline(false)
    } catch {
      setBackendOffline(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTrips() }, [])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Topbar actions={<NewTripButton onClick={() => setShowModal(true)} />} />

      <div style={{ padding: '24px 24px 64px' }}>
        {/* Backend offline banner */}
        {backendOffline && !loading && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              borderRadius: 12, padding: '12px 16px', marginBottom: 20, fontSize: 13,
              background: 'rgba(69,10,10,0.4)', border: '1px solid #7f1d1d',
            }}
          >
            <ServerCrash size={15} style={{ color: '#f87171', flexShrink: 0 }} />
            <span style={{ color: '#fca5a5' }}>
              Backend not reachable. Start it with{' '}
              <code style={{ padding: '1px 4px', borderRadius: 4, fontSize: 12, background: 'rgba(69,10,10,0.6)', color: '#fca5a5' }}>
                ./start.sh
              </code>
              .
            </span>
          </div>
        )}

        {/* Trip grid */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{ height: 288, borderRadius: 12, background: 'var(--surface)', animation: 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite' }}
              />
            ))}
          </div>
        ) : trips.length === 0 ? (
          <EmptyState onNew={() => setShowModal(true)} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {trips.map((trip) => (
              <TripCard key={trip.id} trip={trip} />
            ))}
            {/* "New trip" placeholder */}
            <button
              onClick={() => setShowModal(true)}
              style={{
                height: 288, borderRadius: 12, border: '2px dashed #3f3f46',
                background: 'var(--surface)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
                cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = '#52525b')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#3f3f46')}
            >
              <div
                style={{
                  width: 52, height: 52, borderRadius: '50%',
                  border: '2px solid #52525b',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 30, fontWeight: 300, color: '#71717A',
                }}
              >
                +
              </div>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa' }}>New Trip</span>
            </button>
          </div>
        )}
      </div>

      {showModal && (
        <CreateTripModal
          onClose={() => setShowModal(false)}
          onCreated={loadTrips}
        />
      )}
    </div>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 112, textAlign: 'center' }}>
      <div
        style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16, fontSize: 24 }}
      >
        📁
      </div>
      <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>No trips yet</p>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', maxWidth: 280, lineHeight: 1.6, marginBottom: 24 }}>
        Create a trip and paste your shared Google Drive folder URL to get started.
      </p>
      <button
        onClick={onNew}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 7, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
      >
        + Create your first trip
      </button>
    </div>
  )
}
