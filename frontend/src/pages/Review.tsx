import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Users, MapPin, HelpCircle, UserX, Loader2 } from 'lucide-react'
import { api, type ClassifyResults, type MiscFace } from '../api/client'

interface FaceCardState {
  mode: 'idle' | 'assign' | 'create'
  selectedPersonId: string
  newName: string
  loading: boolean
}

function defaultFS(): FaceCardState {
  return { mode: 'idle', selectedPersonId: '', newName: '', loading: false }
}

export function Review() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [tripName, setTripName] = useState('')
  const [outputFolderId, setOutputFolderId] = useState<string | null>(null)
  const [results, setResults] = useState<ClassifyResults | null>(null)
  const [miscFaces, setMiscFaces] = useState<MiscFace[]>([])
  const [miscCount, setMiscCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [faceStates, setFaceStates] = useState<Record<string, FaceCardState>>({})

  useEffect(() => {
    if (!id) return
    const load = async () => {
      try {
        const [trip, res, miscRes] = await Promise.all([
          api.trips.get(id),
          api.classify.results(id),
          api.review.getMisc(id),
        ])
        setTripName(trip.name)
        setOutputFolderId(trip.output_folder_id)
        setResults(res)
        setMiscFaces(miscRes.faces)
        setMiscCount(miscRes.count)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load review')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  function getFS(faceId: string): FaceCardState {
    return faceStates[faceId] ?? defaultFS()
  }

  function setFS(faceId: string, update: Partial<FaceCardState>) {
    setFaceStates(s => ({
      ...s,
      [faceId]: { ...defaultFS(), ...s[faceId], ...update },
    }))
  }

  async function assignFace(faceId: string) {
    const fs = getFS(faceId)
    if (!fs.selectedPersonId || !id) return
    setFS(faceId, { loading: true })
    try {
      await api.review.assignMisc(id, faceId, fs.selectedPersonId)
      setMiscFaces(f => f.filter(x => x.face_id !== faceId))
      setMiscCount(c => c - 1)
      const newResults = await api.classify.results(id)
      setResults(newResults)
    } catch {
      setFS(faceId, { loading: false })
    }
  }

  async function createFromFace(faceId: string) {
    const fs = getFS(faceId)
    if (!fs.newName.trim() || !id) return
    setFS(faceId, { loading: true })
    try {
      await api.review.createPersonFromMisc(id, faceId, fs.newName.trim())
      setMiscFaces(f => f.filter(x => x.face_id !== faceId))
      setMiscCount(c => c - 1)
      const newResults = await api.classify.results(id)
      setResults(newResults)
    } catch {
      setFS(faceId, { loading: false })
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="text-violet-400 animate-spin" size={28} />
      </div>
    )
  }

  if (error || !results) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-400 mb-4">{error ?? 'Failed to load review'}</p>
          <button onClick={() => navigate(-1)} className="text-violet-400 text-sm hover:underline">← Go back</button>
        </div>
      </div>
    )
  }

  const totalPersonPhotos = results.persons.reduce((s, p) => s + p.photo_count, 0)
  const totalScenePhotos = Object.values(results.scene_counts).reduce((a, b) => a + b, 0)

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-3xl mx-auto px-6 py-10">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <button
            onClick={() => navigate(`/trips/${id}`)}
            className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
          >
            <ArrowLeft size={16} /> Back to trip
          </button>
          {outputFolderId && (
            <a
              href={`https://drive.google.com/drive/folders/${outputFolderId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-violet-400 hover:text-violet-300 transition-colors"
            >
              View on Drive <ExternalLink size={13} />
            </a>
          )}
        </div>

        <h1 className="text-2xl font-bold text-white mb-1">{tripName}</h1>
        <p className="text-zinc-500 text-sm mb-8">Classification review</p>

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-3 mb-10">
          <StatCard icon={<Users size={16} />} label="People" value={results.persons.length} sub={`${totalPersonPhotos} photos`} />
          <StatCard icon={<MapPin size={16} />} label="Places" value={totalScenePhotos} sub={`${Object.keys(results.scene_counts).length} categories`} />
          <StatCard icon={<HelpCircle size={16} />} label="Misc" value={miscCount} sub="unidentified faces" />
        </div>

        {/* People */}
        <section className="mb-10">
          <h2 className="text-xs font-mono text-zinc-600 uppercase tracking-widest mb-4">People</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {results.persons.map(p => (
              <div key={p.person_id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex items-center gap-3">
                <img
                  src={`/api/persons/${p.person_id}/thumbnail`}
                  alt={p.name}
                  className="w-10 h-10 rounded-full object-cover bg-zinc-800 flex-shrink-0"
                  onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                />
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{p.name}</p>
                  <p className="text-zinc-500 text-xs">{p.photo_count} photos</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Places */}
        {Object.keys(results.scene_counts).length > 0 && (
          <section className="mb-10">
            <h2 className="text-xs font-mono text-zinc-600 uppercase tracking-widest mb-4">Places</h2>
            <div className="flex flex-wrap gap-2">
              {Object.entries(results.scene_counts).map(([label, count]) => (
                <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
                  <p className="text-zinc-300 capitalize text-sm font-medium">{label}</p>
                  <p className="text-zinc-500 text-xs mt-0.5">{count} {count === 1 ? 'photo' : 'photos'}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Misc */}
        <section className="mb-10">
          <h2 className="text-xs font-mono text-zinc-600 uppercase tracking-widest mb-4">
            Misc — Unidentified Faces
          </h2>
          {miscCount === 0 ? (
            <p className="text-zinc-600 text-sm">
              No unidentified faces. All faces were assigned or dismissed during enrollment.
            </p>
          ) : (
            <>
              <p className="text-zinc-500 text-sm mb-4">
                {miscCount} face{miscCount !== 1 ? 's' : ''} not matched to any person.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {miscFaces.map(face => {
                  const fs = getFS(face.face_id)
                  return (
                    <MiscFaceCard
                      key={face.face_id}
                      face={face}
                      fs={fs}
                      persons={results.persons}
                      onSetMode={mode => setFS(face.face_id, { mode })}
                      onSelectPerson={personId => setFS(face.face_id, { selectedPersonId: personId })}
                      onSetNewName={name => setFS(face.face_id, { newName: name })}
                      onAssign={() => assignFace(face.face_id)}
                      onCreate={() => createFromFace(face.face_id)}
                      onCancel={() => setFS(face.face_id, { mode: 'idle' })}
                    />
                  )
                })}
              </div>
              <p className="text-xs text-zinc-600 mt-4">
                After assigning faces, re-upload to Drive (from the trip page) to create shortcuts in the person&apos;s folder.
              </p>
            </>
          )}
        </section>

      </div>
    </div>
  )
}

function StatCard({ icon, label, value, sub }: {
  icon: React.ReactNode; label: string; value: number; sub: string
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center gap-2 text-zinc-500 text-xs mb-2">{icon}{label}</div>
      <p className="text-white text-2xl font-bold">{value}</p>
      <p className="text-zinc-600 text-xs mt-0.5">{sub}</p>
    </div>
  )
}

function MiscFaceCard({ face, fs, persons, onSetMode, onSelectPerson, onSetNewName, onAssign, onCreate, onCancel }: {
  face: MiscFace
  fs: FaceCardState
  persons: { name: string; person_id: string; photo_count: number }[]
  onSetMode: (mode: FaceCardState['mode']) => void
  onSelectPerson: (id: string) => void
  onSetNewName: (name: string) => void
  onAssign: () => void
  onCreate: () => void
  onCancel: () => void
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2">
      {face.face_crop ? (
        <img
          src={`data:image/jpeg;base64,${face.face_crop}`}
          alt="Unknown face"
          className="w-full aspect-square object-cover rounded-lg bg-zinc-800"
        />
      ) : (
        <div className="w-full aspect-square bg-zinc-800 rounded-lg flex items-center justify-center">
          <UserX size={24} className="text-zinc-600" />
        </div>
      )}

      <p className="text-xs text-zinc-500 truncate">{face.photo_name ?? '—'}</p>

      {fs.mode === 'idle' && (
        <div className="flex gap-1.5">
          <button
            onClick={() => onSetMode('assign')}
            className="flex-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-2 py-1.5 rounded transition-colors"
          >
            Assign
          </button>
          <button
            onClick={() => onSetMode('create')}
            className="flex-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-2 py-1.5 rounded transition-colors"
          >
            New person
          </button>
        </div>
      )}

      {fs.mode === 'assign' && (
        <div className="flex flex-col gap-1.5">
          <select
            value={fs.selectedPersonId}
            onChange={e => onSelectPerson(e.target.value)}
            className="w-full text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 px-2 py-1.5 rounded"
          >
            <option value="">Select person…</option>
            {persons.map(p => (
              <option key={p.person_id} value={p.person_id}>{p.name}</option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <button
              onClick={onAssign}
              disabled={!fs.selectedPersonId || fs.loading}
              className="flex-1 text-xs bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white px-2 py-1.5 rounded transition-colors"
            >
              {fs.loading ? '…' : 'Assign'}
            </button>
            <button
              onClick={onCancel}
              className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 px-2 py-1.5 rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {fs.mode === 'create' && (
        <div className="flex flex-col gap-1.5">
          <input
            type="text"
            placeholder="Name…"
            value={fs.newName}
            onChange={e => onSetNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onCreate()}
            autoFocus
            className="w-full text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 px-2 py-1.5 rounded placeholder-zinc-600 outline-none focus:border-violet-500"
          />
          <div className="flex gap-1.5">
            <button
              onClick={onCreate}
              disabled={!fs.newName.trim() || fs.loading}
              className="flex-1 text-xs bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white px-2 py-1.5 rounded transition-colors"
            >
              {fs.loading ? '…' : 'Create'}
            </button>
            <button
              onClick={onCancel}
              className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 px-2 py-1.5 rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
