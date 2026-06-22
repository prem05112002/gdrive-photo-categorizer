import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import { api, type GroupPhoto, type FaceCluster, type EnrolledPerson } from '../api/client'
import { Topbar } from '../components/Topbar'

export function Enroll() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [groupPhotos, setGroupPhotos]     = useState<GroupPhoto[]>([])
  const [clusters, setClusters]           = useState<FaceCluster[]>([])
  const [named, setNamed]                 = useState(0)
  const [expected, setExpected]           = useState<number | null>(null)
  const [nameInputs, setNameInputs]       = useState<Record<number, string>>({})
  const [saving, setSaving]               = useState<Set<number>>(new Set())
  const [savedNames, setSavedNames]       = useState<Record<number, string>>({})
  const [dismissed, setDismissed]         = useState<Set<number>>(new Set())
  const [carouselIdx, setCarouselIdx]     = useState(0)
  const [tripName, setTripName]           = useState('')
  const [enrolledPersons, setEnrolledPersons] = useState<EnrolledPerson[]>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting]           = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    async function load() {
      try {
        const [trip, photosData, clusterData, personsData] = await Promise.all([
          api.trips.get(id!),
          api.enrollment.groupPhotos(id!),
          api.enrollment.clusters(id!),
          api.enrollment.persons(id!),
        ])
        setTripName(trip.name)
        setGroupPhotos(photosData)
        setClusters(clusterData.clusters)
        setNamed(clusterData.named)
        setExpected(clusterData.expected)
        setEnrolledPersons(personsData)
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
      const personsData = await api.enrollment.persons(id)
      setEnrolledPersons(personsData)
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

  async function deletePerson(personId: string) {
    if (!id) return
    setDeleting(personId)
    try {
      await api.enrollment.deletePerson(id, personId)
      setEnrolledPersons(prev => prev.filter(p => p.person_id !== personId))
      setNamed(prev => Math.max(0, prev - 1))
      // Reload clusters — freed faces may now appear as pending clusters
      const clusterData = await api.enrollment.clusters(id)
      setClusters(clusterData.clusters)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleting(null)
      setConfirmDeleteId(null)
    }
  }

  async function dismissAll(targets: FaceCluster[]) {
    if (!id) return
    for (const c of targets) {
      if (!dismissed.has(c.cluster_id)) {
        try {
          await api.enrollment.dismissCluster(id, c.face_ids)
          setDismissed(prev => new Set(prev).add(c.cluster_id))
        } catch { /* continue */ }
      }
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <Loader2 className="animate-spin" size={24} style={{ color: 'var(--accent)' }} />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <p style={{ color: 'var(--error)' }}>{error}</p>
      </div>
    )
  }

  const activeClusters    = clusters.filter(c => !(c.cluster_id in savedNames) && !dismissed.has(c.cluster_id))
  const groupClusters     = activeClusters.filter(c => !c.is_singleton)
  const singletonClusters = activeClusters.filter(c => c.is_singleton)
  const coveragePct       = expected ? Math.min(Math.round((named / expected) * 100), 100) : 0
  const currentPhoto      = groupPhotos[carouselIdx]

  const breadcrumbs = [
    { label: tripName, href: `/trips/${id}` },
    { label: 'Enroll' },
  ]

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Topbar
        breadcrumbs={breadcrumbs}
        backHref={`/trips/${id}`}
        actions={
          named > 0 ? (
            <button
              onClick={() => navigate(`/trips/${id}`)}
              style={{ background: '#22C55E', color: '#06140b', border: 'none', borderRadius: 7, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              Done ✓
            </button>
          ) : undefined
        }
      />

      <div style={{ display: 'flex', flex: 1 }}>

        {/* ── Left: Group photo carousel ── */}
        <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid var(--border)', padding: 22, background: 'var(--bg)' }}>

          <div style={{ fontSize: 12, fontWeight: 600, color: '#71717A', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
            Group photos
          </div>

          {groupPhotos.length > 0 && currentPhoto ? (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', color: '#71717A', marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentPhoto.file_name} · {currentPhoto.face_count} faces
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {currentPhoto.face_crops.slice(0, 6).map((crop, i) => (
                  <img
                    key={i}
                    src={`data:image/jpeg;base64,${crop}`}
                    style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8 }}
                    alt=""
                  />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, textAlign: 'center' }}>
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No group photos found</p>
            </div>
          )}

          {/* Carousel nav */}
          {groupPhotos.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
              <button
                onClick={() => setCarouselIdx(i => Math.max(0, i - 1))}
                disabled={carouselIdx === 0}
                style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)', color: '#a1a1aa', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: carouselIdx === 0 ? 0.3 : 1 }}
              >
                <ChevronLeft size={14} />
              </button>
              {groupPhotos.length <= 10 ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  {groupPhotos.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setCarouselIdx(i)}
                      style={{ width: 7, height: 7, borderRadius: '50%', background: i === carouselIdx ? 'var(--accent)' : '#3f3f46', border: 'none', cursor: 'pointer', padding: 0 }}
                    />
                  ))}
                </div>
              ) : (
                <span style={{ fontSize: 12, color: '#71717A', fontVariantNumeric: 'tabular-nums' }}>
                  {carouselIdx + 1} / {groupPhotos.length}
                </span>
              )}
              <button
                onClick={() => setCarouselIdx(i => Math.min(groupPhotos.length - 1, i + 1))}
                disabled={carouselIdx === groupPhotos.length - 1}
                style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)', color: '#a1a1aa', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: carouselIdx === groupPhotos.length - 1 ? 0.3 : 1 }}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          {/* Identified progress */}
          {expected && (
            <div style={{ marginTop: 22 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, color: '#a1a1aa', marginBottom: 8 }}>
                <span>Identified</span>
                <span style={{ color: 'var(--text-primary)' }}>{named} / {expected}</span>
              </div>
              <div style={{ height: 8, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--border)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${coveragePct}%`, background: 'var(--accent)', borderRadius: 6, transition: 'width 0.5s' }} />
              </div>
            </div>
          )}
        </div>

        {/* ── Right: Roster ── */}
        <div style={{ flex: 1, minWidth: 0, padding: '24px 26px', overflowY: 'auto' }}>

          {/* Group members */}
          {groupClusters.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Group members</span>
                <span style={{ fontSize: 12, color: '#71717A' }}>clusters with ≥3 appearances</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {groupClusters.map(cluster => (
                  <ClusterRow
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

          {/* Enrolled roster — loaded from DB, persistent across sessions */}
          {enrolledPersons.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>
                Enrolled roster
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {enrolledPersons.map(person => (
                  <div
                    key={person.person_id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 10, padding: '10px 12px',
                    }}
                  >
                    {person.thumbnail ? (
                      <img
                        src={`data:image/jpeg;base64,${person.thumbnail}`}
                        style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                        alt=""
                      />
                    ) : (
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--surface-2)', flexShrink: 0 }} />
                    )}
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {person.name}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 8 }}>
                      {person.face_count} photo{person.face_count !== 1 ? 's' : ''}
                    </span>

                    {confirmDeleteId === person.person_id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Remove?</span>
                        <button
                          onClick={() => deletePerson(person.person_id)}
                          disabled={deleting === person.person_id}
                          style={{ fontSize: 12, fontWeight: 600, color: '#fca5a5', background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
                        >
                          {deleting === person.person_id ? <Loader2 size={12} className="animate-spin" /> : 'Yes'}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          style={{ fontSize: 12, color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(person.person_id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px', cursor: 'pointer' }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'var(--error)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,.4)' }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)' }}
                      >
                        <Trash2 size={12} /> Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Likely strangers */}
          {singletonClusters.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Likely strangers</span>
                  <span style={{ fontSize: 12, color: '#71717A' }}>singletons</span>
                </div>
                <button
                  onClick={() => dismissAll(singletonClusters)}
                  style={{ background: 'transparent', color: '#a1a1aa', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  Dismiss all ({singletonClusters.length})
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
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

          {clusters.length === 0 && (
            <div style={{ paddingTop: 64, textAlign: 'center' }}>
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>All faces have been named or dismissed.</p>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}

// ── Cluster row ────────────────────────────────────────────────────────────────

function ClusterRow({ cluster, value, onChange, onSave, saving }: {
  cluster: FaceCluster
  value: string
  onChange: (v: string) => void
  onSave: () => void
  saving: boolean
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '12px 14px',
      }}
    >
      {/* Overlapping face crops */}
      <div style={{ display: 'flex', flexShrink: 0 }}>
        {cluster.representative_crops.slice(0, 3).map((crop, i) => (
          <img
            key={i}
            src={`data:image/jpeg;base64,${crop}`}
            style={{
              width: 44, height: 44, borderRadius: 10, objectFit: 'cover',
              border: '2px solid var(--surface)',
              marginLeft: i > 0 ? -12 : 0,
            }}
            alt=""
          />
        ))}
      </div>

      <span style={{ fontSize: 12, fontWeight: 500, color: '#71717A', width: 90, flexShrink: 0 }}>
        {cluster.size} appearances
      </span>

      {/* Name input */}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSave() }}
        placeholder="Name this person…"
        style={{
          flex: 1, height: 38, border: '1px solid var(--border)', borderRadius: 8,
          background: 'var(--bg)', color: '#52525b', padding: '0 12px', fontSize: 13, outline: 'none',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--text-primary)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = '#52525b' }}
      />

      <button
        onClick={onSave}
        disabled={!value.trim() || saving}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none',
          borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600,
          cursor: !value.trim() || saving ? 'not-allowed' : 'pointer',
          opacity: !value.trim() || saving ? 0.4 : 1,
          flexShrink: 0,
        }}
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
      </button>
    </div>
  )
}

// ── Singleton card ─────────────────────────────────────────────────────────────

function SingletonCard({ cluster, onDismiss, onName }: {
  cluster: FaceCluster
  onDismiss: () => void
  onName: (val: string) => void
}) {
  const [showInput, setShowInput] = useState(false)
  const [val, setVal] = useState('')

  return (
    <div
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 12, textAlign: 'center',
      }}
    >
      {cluster.representative_crops[0] && (
        <img
          src={`data:image/jpeg;base64,${cluster.representative_crops[0]}`}
          style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 10, marginBottom: 8, display: 'block' }}
          alt=""
        />
      )}
      <div style={{ fontSize: 11, fontWeight: 500, color: '#71717A', marginBottom: 8 }}>
        {cluster.size}×
      </div>

      {showInput ? (
        <input
          type="text"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && val.trim()) onName(val.trim()) }}
          onBlur={() => { if (!val.trim()) setShowInput(false) }}
          autoFocus
          placeholder="Name…"
          style={{
            width: '100%', boxSizing: 'border-box', borderRadius: 6, padding: '4px 8px', fontSize: 11, outline: 'none',
            background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-primary)',
          }}
        />
      ) : (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setShowInput(true)}
            style={{ flex: 1, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 0', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
          >
            Name
          </button>
          <button
            onClick={onDismiss}
            style={{ width: 30, background: 'var(--bg)', color: '#71717A', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
