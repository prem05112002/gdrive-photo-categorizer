import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle, Loader2, X, Users } from 'lucide-react'
import { api, type GroupPhoto, type FaceCluster } from '../api/client'

export function Enroll() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [groupPhotos, setGroupPhotos] = useState<GroupPhoto[]>([])
  const [clusters, setClusters] = useState<FaceCluster[]>([])
  const [named, setNamed] = useState(0)
  const [expected, setExpected] = useState<number | null>(null)
  const [nameInputs, setNameInputs] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<Set<number>>(new Set())
  const [savedNames, setSavedNames] = useState<Record<number, string>>({})
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!id) return
    async function load() {
      try {
        const [photosData, clusterData] = await Promise.all([
          api.enrollment.groupPhotos(id!),
          api.enrollment.clusters(id!),
        ])
        setGroupPhotos(photosData)
        setClusters(clusterData.clusters)
        setNamed(clusterData.named)
        setExpected(clusterData.expected)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load enrollment data')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  async function saveName(cluster: FaceCluster, nameOverride?: string) {
    if (!id) return
    const name = (nameOverride ?? nameInputs[cluster.cluster_id] ?? '').trim()
    if (!name) return
    setSaving(prev => new Set(prev).add(cluster.cluster_id))
    try {
      await api.enrollment.nameCluster(id, name, cluster.face_ids)
      setSavedNames(prev => ({ ...prev, [cluster.cluster_id]: name }))
      setNamed(prev => prev + 1)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(prev => { const s = new Set(prev); s.delete(cluster.cluster_id); return s })
    }
  }

  async function dismissCluster(cluster: FaceCluster) {
    if (!id) return
    try {
      await api.enrollment.dismissCluster(id, cluster.face_ids)
      setDismissed(prev => new Set(prev).add(cluster.cluster_id))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Dismiss failed')
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <Loader2 className="text-violet-400 animate-spin" size={28} />
    </div>
  )

  if (error) return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <p className="text-red-400">{error}</p>
    </div>
  )

  const activeClusters = clusters.filter(
    c => !(c.cluster_id in savedNames) && !dismissed.has(c.cluster_id)
  )
  const groupClusters = activeClusters.filter(c => !c.is_singleton)
  const singletonClusters = activeClusters.filter(c => c.is_singleton)
  const namedEntries = Object.entries(savedNames)
  const coveragePct = expected ? Math.min(Math.round((named / expected) * 100), 100) : 0

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-4xl mx-auto px-6 py-10">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <button
            onClick={() => navigate(`/trips/${id}`)}
            className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
          >
            <ArrowLeft size={16} /> Back to trip
          </button>
          {named > 0 && (
            <button
              onClick={() => navigate(`/trips/${id}`)}
              className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 rounded-lg text-sm font-medium transition-colors"
            >
              <CheckCircle size={15} /> Done
            </button>
          )}
        </div>

        <h1 className="text-2xl font-bold mb-6">Enrollment</h1>

        {/* Coverage Bar */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-8">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-zinc-400 flex items-center gap-1.5">
              <Users size={14} /> People identified
            </span>
            <span className="text-white font-medium">
              {named}{expected ? ` / ${expected}` : ''}
            </span>
          </div>
          {expected && (
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 rounded-full transition-all duration-500"
                style={{ width: `${coveragePct}%` }}
              />
            </div>
          )}
        </div>

        {/* Group Photos */}
        {groupPhotos.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-3">
              Group Photos
            </h2>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {groupPhotos.map(photo => (
                <div
                  key={photo.id}
                  className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-xl p-3 w-56"
                >
                  <div className="flex gap-1 mb-2 flex-wrap">
                    {photo.face_crops.map((crop, i) => (
                      <img
                        key={i}
                        src={`data:image/jpeg;base64,${crop}`}
                        className="w-8 h-8 rounded object-cover"
                        alt=""
                      />
                    ))}
                  </div>
                  <p className="text-xs text-zinc-400 truncate">{photo.file_name}</p>
                  <p className="text-xs text-zinc-600">{photo.face_count} faces</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Group member clusters */}
        {groupClusters.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-3">
              Group Members
              <span className="text-zinc-700 font-normal ml-2 normal-case">
                {groupClusters.length} clusters · ≥3 appearances each
              </span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {groupClusters.map(cluster => (
                <ClusterCard
                  key={cluster.cluster_id}
                  cluster={cluster}
                  value={nameInputs[cluster.cluster_id] || ''}
                  onChange={val => setNameInputs(prev => ({ ...prev, [cluster.cluster_id]: val }))}
                  onSave={() => saveName(cluster)}
                  saving={saving.has(cluster.cluster_id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Singleton / rare clusters */}
        {singletonClusters.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-3">
              Unknown Faces
              <span className="text-zinc-700 font-normal ml-2 normal-case">
                appeared once or twice — likely strangers
              </span>
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {singletonClusters.map(cluster => (
                <SingletonCard
                  key={cluster.cluster_id}
                  cluster={cluster}
                  onDismiss={() => dismissCluster(cluster)}
                  onName={val => saveName(cluster, val)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Named summary */}
        {namedEntries.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-3">Named</h2>
            <div className="flex flex-wrap gap-2">
              {namedEntries.map(([clusterId, name]) => {
                const cluster = clusters.find(c => c.cluster_id === Number(clusterId))
                return (
                  <div
                    key={clusterId}
                    className="flex items-center gap-2 bg-zinc-900 border border-emerald-900 rounded-lg px-3 py-2"
                  >
                    {cluster?.representative_crops[0] && (
                      <img
                        src={`data:image/jpeg;base64,${cluster.representative_crops[0]}`}
                        className="w-7 h-7 rounded-full object-cover"
                        alt=""
                      />
                    )}
                    <span className="text-sm text-emerald-400">{name}</span>
                    <CheckCircle size={13} className="text-emerald-600" />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {clusters.length === 0 && (
          <div className="text-center py-16 text-zinc-600">
            No unenrolled faces — all faces have been named or dismissed.
          </div>
        )}

      </div>
    </div>
  )
}

function ClusterCard({ cluster, value, onChange, onSave, saving }: {
  cluster: FaceCluster
  value: string
  onChange: (v: string) => void
  onSave: () => void
  saving: boolean
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex gap-2 mb-3">
        {cluster.representative_crops.slice(0, 4).map((crop, i) => (
          <img
            key={i}
            src={`data:image/jpeg;base64,${crop}`}
            className="w-14 h-14 rounded-lg object-cover"
            alt=""
          />
        ))}
      </div>
      <p className="text-xs text-zinc-600 mb-3">{cluster.size} appearances</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSave() }}
          placeholder="Enter name…"
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
        />
        <button
          onClick={onSave}
          disabled={!value.trim() || saving}
          className="px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </button>
      </div>
    </div>
  )
}

function SingletonCard({ cluster, onDismiss, onName }: {
  cluster: FaceCluster
  onDismiss: () => void
  onName: (val: string) => void
}) {
  const [showInput, setShowInput] = useState(false)
  const [val, setVal] = useState('')

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
      <div className="flex gap-1 mb-2">
        {cluster.representative_crops.slice(0, 2).map((crop, i) => (
          <img
            key={i}
            src={`data:image/jpeg;base64,${crop}`}
            className="w-12 h-12 rounded-lg object-cover"
            alt=""
          />
        ))}
      </div>
      <p className="text-xs text-zinc-700 mb-2">
        {cluster.size} appearance{cluster.size !== 1 ? 's' : ''}
      </p>
      {showInput ? (
        <input
          type="text"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && val.trim()) onName(val.trim()) }}
          onBlur={() => { if (!val.trim()) setShowInput(false) }}
          autoFocus
          placeholder="Name…"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-violet-500"
        />
      ) : (
        <div className="flex gap-1">
          <button
            onClick={() => setShowInput(true)}
            className="flex-1 text-xs text-zinc-500 hover:text-white border border-zinc-800 hover:border-zinc-600 rounded px-2 py-1 transition-colors"
          >
            Name
          </button>
          <button
            onClick={onDismiss}
            className="text-xs text-zinc-600 hover:text-red-400 border border-zinc-800 hover:border-red-900 rounded px-2 py-1 transition-colors"
            title="Dismiss as stranger"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
