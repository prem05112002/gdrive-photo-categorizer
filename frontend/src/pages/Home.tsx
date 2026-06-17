import { useState, useEffect } from 'react'
import { Plus, FolderOpen, ServerCrash } from 'lucide-react'
import { api, type Trip } from '../api/client'
import { TripCard } from '../components/TripCard'
import { CreateTripModal } from '../components/CreateTripModal'

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
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-2xl font-bold text-white">Photo Categorizer</h1>
            <p className="text-zinc-500 text-sm mt-1">Organize trip photos by person using face recognition</p>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-lg text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            New Trip
          </button>
        </div>

        {/* Backend offline banner */}
        {backendOffline && !loading && (
          <div className="flex items-center gap-3 bg-red-950/50 border border-red-900 rounded-xl px-4 py-3 mb-6 text-sm">
            <ServerCrash size={16} className="text-red-400 shrink-0" />
            <span className="text-red-300">Backend not reachable. Start it with <code className="bg-red-950 px-1 rounded text-xs">./start.sh</code> or check <code className="bg-red-950 px-1 rounded text-xs">localhost:8000/api/health</code>.</span>
          </div>
        )}

        {/* Trip list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-28 bg-zinc-900 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : trips.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 bg-zinc-800 rounded-xl flex items-center justify-center mb-4">
              <FolderOpen size={26} className="text-zinc-500" />
            </div>
            <p className="text-zinc-400 font-medium mb-1">No trips yet</p>
            <p className="text-zinc-600 text-sm mb-6">
              Create a trip and paste your shared Google Drive folder URL to get started.
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-lg text-sm font-medium transition-colors"
            >
              <Plus size={16} />
              Create your first trip
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {trips.map((trip) => (
              <TripCard key={trip.id} trip={trip} />
            ))}
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
