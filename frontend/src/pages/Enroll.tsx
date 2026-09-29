import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, ChevronLeft, ChevronRight, ChevronDown, Trash2, X, Maximize2, ImageOff } from 'lucide-react'
import { api, type GroupPhoto, type GroupPhotoFace, type FaceCluster, type EnrolledPerson } from '../api/client'
import { Topbar } from '../components/Topbar'
import { FaceLightbox } from '../components/FaceLightbox'
import { countLabel } from '../lib/faces'

const LEFT_PANEL_WIDTH = 400
const TOPBAR_HEIGHT = 56   // Topbar is sticky at top:0 — the reference panel sticks just below it
const HIGHLIGHT_MS = 1800

type SavedName = { name: string; personId: string }
type FaceState = 'named' | 'pending' | 'inactive'
type FaceLabel = { name: string | null; state: FaceState }
type Highlight = { id: number; at: number }
type LightboxState = { cluster: FaceCluster; index: number }

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
  const [savedNames, setSavedNames]       = useState<Record<number, SavedName>>({})
  const [dismissed, setDismissed]         = useState<Set<number>>(new Set())
  const [lowQuality, setLowQuality]       = useState(0)
  const [showStrangers, setShowStrangers] = useState(false)
  const [carouselIdx, setCarouselIdx]     = useState(0)
  const [tripName, setTripName]           = useState('')
  const [enrolledPersons, setEnrolledPersons] = useState<EnrolledPerson[]>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting]           = useState<string | null>(null)
  const [lightbox, setLightbox]           = useState<LightboxState | null>(null)
  const [photoOverlay, setPhotoOverlay]   = useState(false)
  const [highlight, setHighlight]         = useState<Highlight | null>(null)
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({})

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
        setLowQuality(clusterData.low_quality_count ?? 0)
        setEnrolledPersons(personsData)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load enrollment data')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  // face_id → cluster_id, so a face clicked on a reference photo can find its roster card
  const faceToCluster = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of clusters) for (const f of c.face_ids) m.set(f, c.cluster_id)
    return m
  }, [clusters])

  // Scroll to and flash the card of a cluster that was jumped to
  useEffect(() => {
    if (!highlight) return
    const raf = requestAnimationFrame(() => {
      cardRefs.current[highlight.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
  }, [highlight])

  // Keyboard: Esc closes overlays, arrows move through samples / reference photos
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setLightbox(null); setPhotoOverlay(false); return }
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (lightbox) {
        const last = lightbox.cluster.representatives.length - 1
        if (e.key === 'ArrowLeft')  setLightbox(lb => lb && { ...lb, index: Math.max(0, lb.index - 1) })
        if (e.key === 'ArrowRight') setLightbox(lb => lb && { ...lb, index: Math.min(last, lb.index + 1) })
      } else if (photoOverlay) {
        if (e.key === 'ArrowLeft')  setCarouselIdx(i => Math.max(0, i - 1))
        if (e.key === 'ArrowRight') setCarouselIdx(i => Math.min(groupPhotos.length - 1, i + 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, photoOverlay, groupPhotos.length])

  async function saveName(cluster: FaceCluster, nameOverride?: string): Promise<boolean> {
    if (!id) return false
    const name = (nameOverride ?? nameInputs[cluster.cluster_id] ?? '').trim()
    if (!name) return false
    setSaving(prev => new Set(prev).add(cluster.cluster_id))
    try {
      const res = await api.enrollment.nameCluster(id, name, cluster.face_ids)
      setSavedNames(prev => ({ ...prev, [cluster.cluster_id]: { name, personId: res.person_id } }))
      setNamed(prev => prev + 1)
      setEnrolledPersons(await api.enrollment.persons(id))
      return true
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed')
      return false
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
      // Freed faces come back as pending clusters, and lose their name on the reference photos
      const [clusterData, photosData] = await Promise.all([
        api.enrollment.clusters(id),
        api.enrollment.groupPhotos(id),
      ])
      setClusters(clusterData.clusters)
      setGroupPhotos(photosData)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleting(null)
      setConfirmDeleteId(null)
    }
  }

  async function confirmSuggestion(cluster: FaceCluster) {
    if (!id || cluster.suggested_cluster_id == null) return
    const target = savedNames[cluster.suggested_cluster_id]
    if (!target) return
    try {
      await api.enrollment.assignFaces(id, target.personId, cluster.face_ids)
      setSavedNames(prev => ({ ...prev, [cluster.cluster_id]: target }))
      setEnrolledPersons(await api.enrollment.persons(id))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Assign failed')
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

  function faceLabel(face: GroupPhotoFace): FaceLabel {
    if (face.person_name) return { name: face.person_name, state: 'named' }
    const cid = faceToCluster.get(face.face_id)
    if (cid == null || dismissed.has(cid)) return { name: null, state: 'inactive' }
    const saved = savedNames[cid]
    return saved ? { name: saved.name, state: 'named' } : { name: null, state: 'pending' }
  }

  function jumpToFace(face: GroupPhotoFace) {
    const cid = faceToCluster.get(face.face_id)
    if (cid == null || dismissed.has(cid)) return
    const cluster = clusters.find(c => c.cluster_id === cid)
    if (!cluster) return
    if (cluster.is_singleton) setShowStrangers(true)
    setPhotoOverlay(false)
    setHighlight({ id: cid, at: Date.now() })
  }

  async function finish() {
    if (!id) return
    // Enrollment is the source of truth for how many people were on the trip —
    // replace the guess typed at trip creation so cards and coverage show the real number
    if (named > 0 && named !== expected) {
      try {
        await api.trips.update(id, { expected_member_count: named })
      } catch { /* cosmetic — never block leaving the page */ }
    }
    navigate(`/trips/${id}`)
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

  const navBtn = (disabled: boolean): React.CSSProperties => ({
    width: 32, height: 32, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)',
    color: '#a1a1aa', display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.3 : 1,
  })

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Topbar
        breadcrumbs={breadcrumbs}
        backHref={`/trips/${id}`}
        actions={
          named > 0 ? (
            <button
              onClick={finish}
              style={{ background: '#22C55E', color: '#06140b', border: 'none', borderRadius: 7, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              Done ✓
            </button>
          ) : undefined
        }
      />

      <div style={{ display: 'flex', flex: 1 }}>

        {/* ── Left: reference photos ── */}
        <div style={{ width: LEFT_PANEL_WIDTH, flexShrink: 0, borderRight: '1px solid var(--border)', padding: 22, background: 'var(--bg)', position: 'sticky', top: TOPBAR_HEIGHT, alignSelf: 'flex-start', maxHeight: `calc(100vh - ${TOPBAR_HEIGHT}px)`, overflowY: 'auto', boxSizing: 'border-box' }}>

          <div style={{ fontSize: 12, fontWeight: 600, color: '#71717A', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Reference photos
          </div>
          <p style={{ fontSize: 12, color: '#71717A', lineHeight: 1.5, margin: '0 0 14px' }}>
            Group shots from this trip, to help you tell people apart. Click a face to jump to its
            cluster on the right — names fill in here as you enroll.
          </p>

          {currentPhoto ? (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 10 }}>
              <ReferencePhoto photo={currentPhoto} tripId={id!} labelFor={faceLabel} onFaceClick={jumpToFace} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: 'ui-monospace, monospace', color: '#71717A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {currentPhoto.file_name} · {currentPhoto.face_count} faces
                </span>
                <button
                  onClick={() => setPhotoOverlay(true)}
                  title="View larger"
                  style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg)', border: '1px solid var(--border)', color: '#a1a1aa', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                >
                  <Maximize2 size={13} />
                </button>
              </div>
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, textAlign: 'center' }}>
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No group photos in this trip (none with 5+ faces).</p>
            </div>
          )}

          {/* Carousel nav */}
          {groupPhotos.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
              <button onClick={() => setCarouselIdx(i => Math.max(0, i - 1))} disabled={carouselIdx === 0} style={navBtn(carouselIdx === 0)}>
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
              <button onClick={() => setCarouselIdx(i => Math.min(groupPhotos.length - 1, i + 1))} disabled={carouselIdx === groupPhotos.length - 1} style={navBtn(carouselIdx === groupPhotos.length - 1)}>
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
                <span style={{ fontSize: 12, color: '#71717A' }}>clusters with ≥3 appearances · click any face to see it in its photo</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {groupClusters.map(cluster => (
                  <ClusterCard
                    key={cluster.cluster_id}
                    cluster={cluster}
                    value={nameInputs[cluster.cluster_id] || ''}
                    onChange={val => setNameInputs(prev => ({ ...prev, [cluster.cluster_id]: val }))}
                    onSave={() => saveName(cluster)}
                    onOpen={index => setLightbox({ cluster, index })}
                    saving={saving.has(cluster.cluster_id)}
                    highlighted={highlight?.id === cluster.cluster_id}
                    cardRef={el => { cardRefs.current[cluster.cluster_id] = el }}
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

          {/* Likely strangers — collapsed by default; suggested faces float to the top */}
          {singletonClusters.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <button
                  onClick={() => setShowStrangers(s => !s)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  <ChevronDown
                    size={16}
                    style={{ color: '#71717A', transform: showStrangers ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
                  />
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Needs review</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#a1a1aa', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: '2px 9px' }}>
                    {singletonClusters.length}
                  </span>
                  <span style={{ fontSize: 12, color: '#71717A' }}>one-off faces — likely strangers</span>
                </button>
                <button
                  onClick={() => dismissAll(singletonClusters)}
                  style={{ background: 'transparent', color: '#a1a1aa', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  Dismiss all ({singletonClusters.length})
                </button>
              </div>
              {showStrangers && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                  {[...singletonClusters]
                    .sort((a, b) => Number(b.suggested_cluster_id != null) - Number(a.suggested_cluster_id != null))
                    .map(cluster => (
                      <SingletonCard
                        key={cluster.cluster_id}
                        cluster={cluster}
                        suggestionName={
                          cluster.suggested_cluster_id != null
                            ? savedNames[cluster.suggested_cluster_id]?.name ?? null
                            : null
                        }
                        hasSuggestion={cluster.suggested_cluster_id != null}
                        onConfirmSuggestion={() => confirmSuggestion(cluster)}
                        onDismiss={() => dismissCluster(cluster)}
                        onName={val => saveName(cluster, val)}
                        onOpen={() => setLightbox({ cluster, index: 0 })}
                        highlighted={highlight?.id === cluster.cluster_id}
                        cardRef={el => { cardRefs.current[cluster.cluster_id] = el }}
                      />
                    ))}
                </div>
              )}
            </div>
          )}

          {lowQuality > 0 && (
            <p style={{ marginTop: 18, fontSize: 12, color: '#71717A' }}>
              {lowQuality} low-quality face{lowQuality !== 1 ? 's' : ''} hidden (blurry, tiny, or uncertain) —
              they'll be matched automatically during classification.
            </p>
          )}

          {clusters.length === 0 && (
            <div style={{ paddingTop: 64, textAlign: 'center' }}>
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>All faces have been named or dismissed.</p>
            </div>
          )}
        </div>

      </div>

      {/* ── Reference photo, large ── */}
      {photoOverlay && currentPhoto && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(8,8,11,.88)', display: 'flex', flexDirection: 'column' }}
          onClick={e => { if (e.target === e.currentTarget) setPhotoOverlay(false) }}
        >
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12 }}>
            <button onClick={() => setPhotoOverlay(false)} style={overlayCloseBtn}><X size={16} /></button>
            <span style={{ fontSize: 13, color: '#a1a1aa', fontFamily: 'ui-monospace, monospace' }}>
              {currentPhoto.file_name} · {currentPhoto.face_count} faces
            </span>
            <span style={{ fontSize: 12, color: '#71717A' }}>click a face to jump to its cluster</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#71717A' }}>
              {carouselIdx + 1} / {groupPhotos.length}
            </span>
          </div>
          <div
            style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}
            onClick={e => { if (e.target === e.currentTarget) setPhotoOverlay(false) }}
          >
            <ReferencePhoto photo={currentPhoto} tripId={id!} labelFor={faceLabel} onFaceClick={jumpToFace} large />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px' }}>
            <button onClick={() => setCarouselIdx(i => Math.max(0, i - 1))} disabled={carouselIdx === 0} style={overlayNavBtn(carouselIdx === 0)}>
              <ChevronLeft size={16} /> Prev
            </button>
            <button onClick={() => setCarouselIdx(i => Math.min(groupPhotos.length - 1, i + 1))} disabled={carouselIdx === groupPhotos.length - 1} style={overlayNavBtn(carouselIdx === groupPhotos.length - 1)}>
              Next <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── Face in context ── */}
      {lightbox && (
        <FaceLightbox
          cluster={lightbox.cluster}
          index={lightbox.index}
          title={savedNames[lightbox.cluster.cluster_id]?.name ?? 'Unnamed cluster'}
          onIndex={index => setLightbox({ cluster: lightbox.cluster, index })}
          onClose={() => setLightbox(null)}
        >
          <LightboxNameRow
            savedName={savedNames[lightbox.cluster.cluster_id]?.name ?? null}
            saving={saving.has(lightbox.cluster.cluster_id)}
            onName={async val => { if (await saveName(lightbox.cluster, val)) setLightbox(null) }}
          />
        </FaceLightbox>
      )}
    </div>
  )
}

const overlayCloseBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 7, padding: '6px 10px',
  color: '#a1a1aa', cursor: 'pointer', display: 'flex', alignItems: 'center',
}

const overlayNavBtn = (disabled: boolean): React.CSSProperties => ({
  background: 'rgba(255,255,255,.06)', border: 'none', borderRadius: 7, padding: '7px 14px',
  color: disabled ? '#71717A' : 'var(--text-primary)', cursor: disabled ? 'default' : 'pointer',
  display: 'flex', alignItems: 'center', gap: 6, opacity: disabled ? 0.4 : 1,
})

// ── Reference photo with clickable face boxes ──────────────────────────────────
//
// Boxes are positioned as percentages of the photo's detection-space size, so
// they stay put at any rendered size without measuring the image.

function ReferencePhoto({ photo, tripId, labelFor, onFaceClick, large = false }: {
  photo: GroupPhoto
  tripId: string
  labelFor: (face: GroupPhotoFace) => FaceLabel
  onFaceClick: (face: GroupPhotoFace) => void
  large?: boolean
}) {
  const [failedId, setFailedId] = useState<string | null>(null)   // photo whose thumbnail failed to load
  const [hover, setHover] = useState<string | null>(null)
  const failed = failedId === photo.id

  if (failed) {
    return (
      <div style={{ aspectRatio: `${photo.det_width} / ${photo.det_height}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'var(--surface-2)', borderRadius: 8, color: '#71717A', fontSize: 12, minWidth: large ? 360 : undefined }}>
        <ImageOff size={18} />
        Photo not in the local cache
      </div>
    )
  }

  const pct = (v: number, of: number) => `${(v / of) * 100}%`
  const colorFor: Record<FaceState, string> = {
    named: '#22C55E',
    pending: '#7C6EF8',
    inactive: 'rgba(255,255,255,.35)',
  }

  return (
    <div style={{ position: 'relative', display: large ? 'inline-block' : 'block', lineHeight: 0 }}>
      <img
        src={api.photos.thumbnailUrl(photo.id, tripId, large ? 1200 : 800)}
        onError={() => setFailedId(photo.id)}
        alt=""
        style={large
          ? { maxWidth: '88vw', maxHeight: '78vh', display: 'block', borderRadius: 8 }
          : { width: '100%', display: 'block', borderRadius: 8 }}
      />
      {photo.faces.map(face => {
        const { name, state } = labelFor(face)
        const clickable = state === 'pending'
        const hovered = hover === face.face_id
        return (
          <div
            key={face.face_id}
            style={{
              position: 'absolute', pointerEvents: 'none',
              left: pct(face.bbox_x, photo.det_width), top: pct(face.bbox_y, photo.det_height),
              width: pct(face.bbox_w, photo.det_width), height: pct(face.bbox_h, photo.det_height),
            }}
          >
            <div
              onClick={clickable ? () => onFaceClick(face) : undefined}
              onMouseEnter={() => setHover(face.face_id)}
              onMouseLeave={() => setHover(null)}
              title={name ?? (clickable ? 'Jump to this cluster' : 'Not up for review — low quality, dismissed, or already assigned')}
              style={{
                position: 'absolute', inset: -3, borderRadius: 5, pointerEvents: 'auto',
                border: `2px solid ${colorFor[state]}`,
                cursor: clickable ? 'pointer' : 'default',
                opacity: state === 'inactive' ? 0.55 : 1,
                boxShadow: hovered && clickable ? '0 0 0 3px rgba(124,110,248,.4)' : '0 0 0 1px rgba(0,0,0,.45)',
                transition: 'box-shadow .12s',
              }}
            />
            {name && (
              <span style={{
                position: 'absolute', top: '100%', left: '50%', transform: 'translate(-50%, 5px)',
                whiteSpace: 'nowrap', fontSize: large ? 12 : 10, fontWeight: 600, lineHeight: 1.4,
                color: '#86efac', background: 'rgba(8,8,11,.85)', borderRadius: 4, padding: '1px 5px',
              }}>
                {name}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Cluster card ───────────────────────────────────────────────────────────────

function ClusterCard({ cluster, value, onChange, onSave, onOpen, saving, highlighted, cardRef }: {
  cluster: FaceCluster
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onOpen: (index: number) => void
  saving: boolean
  highlighted: boolean
  cardRef: (el: HTMLDivElement | null) => void
}) {
  const hero = cluster.representatives[0]
  const samples = cluster.representatives.slice(1)

  return (
    <div
      ref={cardRef}
      style={{
        display: 'flex', gap: 16,
        background: 'var(--surface)',
        border: `1px solid ${highlighted ? 'var(--accent)' : 'var(--border)'}`,
        boxShadow: highlighted ? '0 0 0 3px rgba(124,110,248,.25)' : 'none',
        borderRadius: 12, padding: 14,
        transition: 'border-color .2s, box-shadow .2s',
      }}
    >
      {hero && (
        <img
          src={`data:image/jpeg;base64,${hero.crop}`}
          onClick={() => onOpen(0)}
          title="See this face in its photo"
          alt=""
          style={{ width: 128, height: 128, borderRadius: 12, objectFit: 'cover', flexShrink: 0, cursor: 'zoom-in', background: 'var(--surface-2)' }}
        />
      )}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {samples.map((rep, i) => (
              <img
                key={rep.face_id}
                src={`data:image/jpeg;base64,${rep.crop}`}
                onClick={() => onOpen(i + 1)}
                title="See this face in its photo"
                alt=""
                style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', cursor: 'zoom-in', background: 'var(--surface-2)' }}
              />
            ))}
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{countLabel(cluster)}</div>
            <div style={{ fontSize: 12, color: '#71717A' }}>appearances on this trip</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSave() }}
            placeholder="Name this person…"
            style={{
              flex: 1, minWidth: 0, height: 38, border: '1px solid var(--border)', borderRadius: 8,
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
      </div>
    </div>
  )
}

// ── Singleton card ─────────────────────────────────────────────────────────────

function SingletonCard({ cluster, suggestionName, hasSuggestion, onConfirmSuggestion, onDismiss, onName, onOpen, highlighted, cardRef }: {
  cluster: FaceCluster
  suggestionName: string | null
  hasSuggestion: boolean
  onConfirmSuggestion: () => void
  onDismiss: () => void
  onName: (val: string) => void
  onOpen: () => void
  highlighted: boolean
  cardRef: (el: HTMLDivElement | null) => void
}) {
  const [showInput, setShowInput] = useState(false)
  const [val, setVal] = useState('')
  const hero = cluster.representatives[0]

  return (
    <div
      ref={cardRef}
      style={{
        background: 'var(--surface)',
        border: highlighted ? '1px solid var(--accent)' : hasSuggestion ? '1px solid rgba(124,110,248,.45)' : '1px solid var(--border)',
        boxShadow: highlighted ? '0 0 0 3px rgba(124,110,248,.25)' : 'none',
        borderRadius: 12, padding: 12, textAlign: 'center',
        transition: 'border-color .2s, box-shadow .2s',
      }}
    >
      {hero && (
        <img
          src={`data:image/jpeg;base64,${hero.crop}`}
          onClick={onOpen}
          title="See this face in its photo"
          alt=""
          style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 10, marginBottom: 8, display: 'block', cursor: 'zoom-in', background: 'var(--surface-2)' }}
        />
      )}
      <div style={{ fontSize: 11, fontWeight: 500, color: '#71717A', marginBottom: 8 }}>
        {cluster.size}×
      </div>

      {suggestionName ? (
        <button
          onClick={onConfirmSuggestion}
          title={`Assign this face to ${suggestionName}`}
          style={{
            display: 'block', width: '100%', marginBottom: 6,
            background: 'rgba(124,110,248,.16)', color: '#c4b5fd',
            border: '1px solid #7C6EF8', borderRadius: 20, padding: '4px 8px',
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {suggestionName}? ✓
        </button>
      ) : hasSuggestion ? (
        <div style={{ marginBottom: 6, fontSize: 10, fontWeight: 600, color: '#c4b5fd' }}>
          similar to a group member
        </div>
      ) : null}

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

// ── Lightbox action row: name the person from the context view ────────────────

function LightboxNameRow({ savedName, saving, onName }: {
  savedName: string | null
  saving: boolean
  onName: (val: string) => void
}) {
  const [val, setVal] = useState('')
  const canSave = !!val.trim() && !saving

  if (savedName) {
    return <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: '#86efac' }}>Enrolled as {savedName}</span>
  }
  return (
    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flex: '1 1 260px', justifyContent: 'flex-end' }}>
      <input
        type="text"
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && canSave) onName(val.trim()) }}
        autoFocus
        placeholder="Name this person…"
        style={{
          flex: '1 1 160px', maxWidth: 320, height: 36, border: '1px solid var(--border)', borderRadius: 8,
          background: 'var(--bg)', color: 'var(--text-primary)', padding: '0 12px', fontSize: 13, outline: 'none',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
      />
      <button
        onClick={() => canSave && onName(val.trim())}
        disabled={!canSave}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '0 16px',
          fontSize: 13, fontWeight: 600, cursor: canSave ? 'pointer' : 'not-allowed', opacity: canSave ? 1 : 0.4, flexShrink: 0,
        }}
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
      </button>
    </div>
  )
}
