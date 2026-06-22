import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ExternalLink, X, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { api, type GalleryData, type GalleryPhoto, type GalleryPerson } from '../api/client'
import { Topbar } from '../components/Topbar'

type FolderKey = string  // person_id | 'place:{label}' | 'misc'

const ALL_SCENE_LABELS = [
  'beach', 'mountain', 'temple', 'monument', 'street',
  'market', 'nature', 'indoor', 'food', 'other',
] as const

const SCENE_LABEL_DISPLAY: Record<string, string> = {
  beach: 'Beach', mountain: 'Mountains', temple: 'Temple', monument: 'Monuments',
  street: 'Street', market: 'Market', nature: 'Nature', indoor: 'Indoors',
  food: 'Food', other: 'Uncategorized',
}

interface Lightbox {
  photos: LightboxPhoto[]
  index: number
  personId: string | null     // null for place/misc folders
  personName: string | null
}

interface LightboxPhoto {
  photoId: string
  filename: string | null
  faceObsId: string | null
  bboxX: number | null
  bboxY: number | null
  bboxW: number | null
  bboxH: number | null
}

interface ImgDims {
  displayX: number
  displayY: number
  displayW: number
  displayH: number
  naturalW: number
  naturalH: number
}

export function Gallery() {
  const { id: tripId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [tripName, setTripName] = useState('')
  const [outputFolderId, setOutputFolderId] = useState<string | null>(null)
  const [gallery, setGallery] = useState<GalleryData | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedFolder, setSelectedFolder] = useState<FolderKey | null>(null)
  const [lightbox, setLightbox] = useState<Lightbox | null>(null)
  const [imgDims, setImgDims] = useState<ImgDims | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [reassigning, setReassigning] = useState(false)
  const [reassigningScene, setReassigningScene] = useState(false)
  const [cacheClearing, setCacheClearing] = useState(false)
  const [showCacheClearConfirm, setShowCacheClearConfirm] = useState(false)

  const imgContainerRef = useRef<HTMLDivElement>(null)

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    if (!tripId) return
    try {
      const [trip, galleryData, syncStatus] = await Promise.all([
        api.trips.get(tripId),
        api.gallery.get(tripId),
        api.sync.syncStatus(tripId),
      ])
      setTripName(trip.name)
      setOutputFolderId(trip.output_folder_id)
      setGallery(galleryData)
      setPendingCount(syncStatus.pending_count)
      setSelectedFolder(prev =>
        prev ?? (galleryData.persons.length > 0 ? galleryData.persons[0].id : 'misc')
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load gallery')
    } finally {
      setLoading(false)
    }
  }, [tripId])

  useEffect(() => { loadAll() }, [loadAll])

  // ── Keyboard navigation ───────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!lightbox) return
      if (e.key === 'Escape') { setLightbox(null); return }
      if (e.key === 'ArrowLeft') moveLightbox(-1)
      if (e.key === 'ArrowRight') moveLightbox(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  // ── Helpers ───────────────────────────────────────────────────────────────

  function moveLightbox(dir: -1 | 1) {
    setLightbox(lb => {
      if (!lb) return lb
      const next = lb.index + dir
      if (next < 0 || next >= lb.photos.length) return lb
      setImgDims(null)
      return { ...lb, index: next }
    })
  }

  function openLightbox(
    photos: LightboxPhoto[],
    index: number,
    personId: string | null,
    personName: string | null,
  ) {
    setImgDims(null)
    setLightbox({ photos, index, personId, personName })
  }

  function personPhotosToLightbox(person: GalleryPerson): LightboxPhoto[] {
    return person.photos.map((p: GalleryPhoto) => ({
      photoId: p.id,
      filename: p.filename,
      faceObsId: p.face_obs_id,
      bboxX: p.bbox_x,
      bboxY: p.bbox_y,
      bboxW: p.bbox_w,
      bboxH: p.bbox_h,
    }))
  }

  function handleImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget
    const container = imgContainerRef.current
    if (!container) return
    const cw = container.clientWidth
    const ch = container.clientHeight
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    if (!nw || !nh) return
    const scale = Math.min(cw / nw, ch / nh)
    const dw = nw * scale
    const dh = nh * scale
    setImgDims({
      displayX: (cw - dw) / 2,
      displayY: (ch - dh) / 2,
      displayW: dw,
      displayH: dh,
      naturalW: nw,
      naturalH: nh,
    })
  }

  // ── Sync actions ──────────────────────────────────────────────────────────

  async function handleSync() {
    if (!tripId) return
    setSyncing(true)
    setSyncMsg(null)
    try {
      const result = await api.sync.syncTrip(tripId)
      setSyncMsg(
        result.failed.length === 0
          ? `✓ Synced ${result.synced} correction${result.synced !== 1 ? 's' : ''}`
          : `Synced ${result.synced}, ${result.failed.length} failed`
      )
      const status = await api.sync.syncStatus(tripId)
      setPendingCount(status.pending_count)
    } catch (e) {
      setSyncMsg('Sync failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSyncing(false)
    }
  }

  async function handleCacheClear() {
    if (!tripId) return
    setCacheClearing(true)
    try {
      const result = await api.sync.clearCache(tripId)
      const mb = (result.freed_bytes / 1024 / 1024).toFixed(1)
      setSyncMsg(`✓ Cache cleared (${mb} MB freed)`)
      setShowCacheClearConfirm(false)
    } catch (e: any) {
      setSyncMsg(e.message ?? 'Clear failed')
      setShowCacheClearConfirm(false)
    } finally {
      setCacheClearing(false)
    }
  }

  // ── Reassign ──────────────────────────────────────────────────────────────

  async function handleReassign(newPersonId: string) {
    if (!lightbox || !tripId) return
    const current = lightbox.photos[lightbox.index]
    if (!current.faceObsId) return
    setReassigning(true)
    try {
      const result = await api.sync.reassign(current.faceObsId, newPersonId)
      setPendingCount(result.pending_count)
      setSyncMsg(null)
      // Refetch gallery and reposition lightbox on the same photo
      await loadAll()
      setLightbox(null)
    } catch (e) {
      setSyncMsg('Reassign failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setReassigning(false)
    }
  }

  async function handleReassignScene(newLabel: string) {
    if (!lbPhoto || !tripId) return
    setReassigningScene(true)
    try {
      await api.photos.updateSceneLabel(lbPhoto.photoId, tripId, newLabel)
      await loadAll()
      setLightbox(null)
    } catch (e) {
      setSyncMsg('Reassign failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setReassigningScene(false)
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const currentPerson = gallery?.persons.find(p => p.id === selectedFolder) ?? null

  let gridPhotos: LightboxPhoto[] = []
  let gridTitle = ''
  let gridCount = 0

  if (gallery && selectedFolder) {
    if (selectedFolder === 'misc') {
      gridTitle = 'Misc'
      gridCount = gallery.misc.length
      gridPhotos = gallery.misc.map(m => ({
        photoId: m.photo_id,
        filename: m.filename,
        faceObsId: null,
        bboxX: null, bboxY: null, bboxW: null, bboxH: null,
      }))
    } else if (selectedFolder.startsWith('place:')) {
      const label = selectedFolder.slice(6)
      const place = gallery.places.find(pl => pl.label === label)
      gridTitle = SCENE_LABEL_DISPLAY[label] ?? label
      gridCount = place?.photos.length ?? 0
      gridPhotos = (place?.photos ?? []).map(p => ({
        photoId: p.id,
        filename: p.filename,
        faceObsId: null,
        bboxX: null, bboxY: null, bboxW: null, bboxH: null,
      }))
    } else {
      const person = gallery.persons.find(p => p.id === selectedFolder)
      if (person) {
        gridTitle = person.name
        gridCount = person.photo_count
        gridPhotos = personPhotosToLightbox(person)
      }
    }
  }

  const lb = lightbox
  const lbPhoto = lb ? lb.photos[lb.index] : null

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <Loader2 className="animate-spin" size={24} style={{ color: 'var(--accent)' }} />
      </div>
    )
  }

  if (error || !gallery) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="text-center">
          <p className="mb-4" style={{ color: 'var(--text-muted)' }}>{error ?? 'Failed to load gallery'}</p>
          <button onClick={() => navigate(-1)} className="text-sm hover:underline" style={{ color: 'var(--accent)' }}>
            ← Go back
          </button>
        </div>
      </div>
    )
  }

  const breadcrumbs = [
    { label: tripName, href: `/trips/${tripId}` },
    { label: 'Gallery' },
  ]

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)' }}>
      <Topbar
        breadcrumbs={breadcrumbs}
        backHref={`/trips/${tripId}`}
        actions={
          outputFolderId ? (
            <a
              href={`https://drive.google.com/drive/folders/${outputFolderId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm"
              style={{ color: 'var(--accent)' }}
            >
              View on Drive <ExternalLink size={12} />
            </a>
          ) : undefined
        }
      />

      <div style={{ display: 'flex', flex: 1, maxWidth: 1200, margin: '0 auto', width: '100%', minHeight: 0 }}>

        {/* ── Sidebar ── */}
        <div style={{
          width: 220, flexShrink: 0,
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ flex: 1, padding: '18px 12px', overflowY: 'auto' }}>

            {/* People */}
            {gallery.persons.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                  People
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 16 }}>
                  {gallery.persons.map(p => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedFolder(p.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '5px 8px', borderRadius: 7,
                        background: selectedFolder === p.id ? 'rgba(124,110,248,.12)' : 'transparent',
                        border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left',
                        transition: 'background 0.1s',
                      }}
                    >
                      {selectedFolder === p.id && (
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                      )}
                      {selectedFolder !== p.id && (
                        <span style={{ width: 5, height: 5, flexShrink: 0 }} />
                      )}
                      <span style={{
                        flex: 1, fontSize: 13,
                        fontWeight: selectedFolder === p.id ? 600 : 400,
                        color: selectedFolder === p.id ? 'var(--text-primary)' : '#a1a1aa',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {p.name}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {p.photo_count}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Places */}
            {gallery.places.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                  Places
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 16 }}>
                  {gallery.places.map(pl => {
                    const key = `place:${pl.label}`
                    return (
                      <button
                        key={key}
                        onClick={() => setSelectedFolder(key)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '5px 8px', borderRadius: 7,
                          background: selectedFolder === key ? 'rgba(124,110,248,.12)' : 'transparent',
                          border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left',
                        }}
                      >
                        <span style={{ width: 5, height: 5, flexShrink: 0, borderRadius: '50%', background: selectedFolder === key ? 'var(--accent)' : 'transparent' }} />
                        <span style={{ flex: 1, fontSize: 13, fontWeight: selectedFolder === key ? 600 : 400, color: selectedFolder === key ? 'var(--text-primary)' : '#a1a1aa' }}>
                          {SCENE_LABEL_DISPLAY[pl.label] ?? pl.label}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pl.photos.length}</span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {/* Misc */}
            {gallery.misc.length > 0 && (
              <button
                onClick={() => setSelectedFolder('misc')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px', borderRadius: 7,
                  background: selectedFolder === 'misc' ? 'rgba(245,158,11,.08)' : 'transparent',
                  border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: '#F59E0B', flex: 1 }}>⚠ Misc</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{gallery.misc.length}</span>
              </button>
            )}
          </div>

          {/* Sync banner */}
          <SyncBanner
            pendingCount={pendingCount}
            syncing={syncing}
            syncMsg={syncMsg}
            onSync={handleSync}
            onClearCache={() => setShowCacheClearConfirm(true)}
          />
        </div>

        {/* ── Photo grid ── */}
        <div style={{ flex: 1, padding: '20px 24px', minWidth: 0, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 16 }}>
            <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{gridTitle}</span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>· {gridCount} photo{gridCount !== 1 ? 's' : ''}</span>
          </div>

          {gridPhotos.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No photos in this folder</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
              {gridPhotos.map((photo, i) => (
                <PhotoTile
                  key={photo.photoId}
                  photo={photo}
                  tripId={tripId!}
                  onClick={() => openLightbox(
                    gridPhotos,
                    i,
                    currentPerson?.id ?? null,
                    currentPerson?.name ?? null,
                  )}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Lightbox ── */}
      {lb && lbPhoto && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(8,8,11,.88)',
            display: 'flex', alignItems: 'stretch',
          }}
          onClick={e => { if (e.target === e.currentTarget) setLightbox(null) }}
        >
          {/* Photo area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {/* Top bar */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12 }}>
              <button
                onClick={() => setLightbox(null)}
                style={{ background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 7, padding: '6px 10px', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              >
                <X size={16} />
              </button>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
                {lbPhoto.filename}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                {lb.index + 1} / {lb.photos.length}
              </span>
            </div>

            {/* Image */}
            <div
              ref={imgContainerRef}
              style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <img
                key={lbPhoto.photoId}
                src={api.photos.imageUrl(lbPhoto.photoId, tripId!)}
                alt={lbPhoto.filename ?? ''}
                onLoad={handleImgLoad}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
              />
              {/* Face bounding box overlay */}
              {imgDims && lbPhoto.bboxX !== null && lbPhoto.bboxY !== null && lbPhoto.bboxW !== null && lbPhoto.bboxH !== null && (
                <FaceBBoxOverlay dims={imgDims} photo={lbPhoto} />
              )}
            </div>

            {/* Prev / next */}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px' }}>
              <button
                onClick={() => moveLightbox(-1)}
                disabled={lb.index === 0}
                style={{
                  background: 'rgba(255,255,255,.06)', border: 'none', borderRadius: 7,
                  padding: '7px 14px', color: lb.index === 0 ? 'var(--text-muted)' : 'var(--text-primary)',
                  cursor: lb.index === 0 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                  opacity: lb.index === 0 ? 0.4 : 1,
                }}
              >
                <ChevronLeft size={16} /> Prev
              </button>
              <button
                onClick={() => moveLightbox(1)}
                disabled={lb.index === lb.photos.length - 1}
                style={{
                  background: 'rgba(255,255,255,.06)', border: 'none', borderRadius: 7,
                  padding: '7px 14px', color: lb.index === lb.photos.length - 1 ? 'var(--text-muted)' : 'var(--text-primary)',
                  cursor: lb.index === lb.photos.length - 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                  opacity: lb.index === lb.photos.length - 1 ? 0.4 : 1,
                }}
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Person reassign panel */}
          {lb.personId && (
            <div style={{
              width: 280, flexShrink: 0,
              borderLeft: '1px solid var(--border)',
              background: 'var(--surface)',
              display: 'flex', flexDirection: 'column',
              padding: '20px 16px',
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                Currently in
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>
                {lb.personName}'s folder
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>
                Move to
              </div>

              {reassigning ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                  <Loader2 size={14} className="animate-spin" /> Reassigning…
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {gallery.persons
                    .filter(p => p.id !== lb.personId)
                    .map(p => (
                      <button
                        key={p.id}
                        onClick={() => handleReassign(p.id)}
                        style={{
                          padding: '8px 12px', borderRadius: 8,
                          background: 'rgba(255,255,255,.04)',
                          border: '1px solid var(--border)',
                          color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
                          cursor: 'pointer', textAlign: 'left',
                          transition: 'background 0.1s, border-color 0.1s',
                        }}
                        onMouseEnter={e => {
                          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(124,110,248,.12)'
                          ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,.04)'
                          ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'
                        }}
                      >
                        {p.name}
                      </button>
                    ))
                  }
                </div>
              )}

              {lbPhoto.faceObsId === null && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 16 }}>
                  No face observation — reassign not available for this photo.
                </p>
              )}

              {syncMsg && (
                <p style={{ fontSize: 12, marginTop: 16, color: syncMsg.startsWith('✓') ? 'var(--success)' : '#fca5a5' }}>
                  {syncMsg}
                </p>
              )}
            </div>
          )}

          {/* Scene reassign panel — shown for place folders */}
          {!lb.personId && selectedFolder?.startsWith('place:') && (() => {
            const currentLabel = selectedFolder.slice(6)
            return (
              <div style={{
                width: 280, flexShrink: 0,
                borderLeft: '1px solid var(--border)',
                background: 'var(--surface)',
                display: 'flex', flexDirection: 'column',
                padding: '20px 16px',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                  Currently in
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>
                  {SCENE_LABEL_DISPLAY[currentLabel] ?? currentLabel}
                </div>

                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>
                  Move to
                </div>

                {reassigningScene ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                    <Loader2 size={14} className="animate-spin" /> Moving…
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {ALL_SCENE_LABELS
                      .filter(l => l !== currentLabel)
                      .map(label => (
                        <button
                          key={label}
                          onClick={() => handleReassignScene(label)}
                          style={{
                            padding: '8px 12px', borderRadius: 8,
                            background: 'rgba(255,255,255,.04)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
                            cursor: 'pointer', textAlign: 'left',
                            transition: 'background 0.1s, border-color 0.1s',
                          }}
                          onMouseEnter={e => {
                            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(124,110,248,.12)'
                            ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'
                          }}
                          onMouseLeave={e => {
                            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,.04)'
                            ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'
                          }}
                        >
                          {SCENE_LABEL_DISPLAY[label] ?? label}
                        </button>
                      ))
                    }
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* ── Cache clear confirm dialog ── */}
      {showCacheClearConfirm && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(8,8,11,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowCacheClearConfirm(false) }}
        >
          <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: '28px 28px', width: 380, border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 10 }}>Clear local cache?</div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24, lineHeight: 1.6 }}>
              This deletes all photos downloaded to disk for this trip. Make sure you've synced all corrections to Drive first — you cannot view gallery photos offline after clearing.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowCacheClearConfirm(false)}
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleCacheClear}
                disabled={cacheClearing}
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, background: '#EF4444', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: cacheClearing ? 'not-allowed' : 'pointer', opacity: cacheClearing ? 0.7 : 1 }}
              >
                {cacheClearing ? 'Clearing…' : 'Clear Cache'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ── Sub-components ─────────────────────────────────────────────────────────────

function PhotoTile({ photo, tripId, onClick }: {
  photo: LightboxPhoto
  tripId: string
  onClick: () => void
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  return (
    <div onClick={onClick} style={{ cursor: 'pointer' }}>
      <div style={{ width: '100%', aspectRatio: '1', borderRadius: 10, overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--border)', position: 'relative' }}>
        {!failed && (
          <img
            src={api.photos.thumbnailUrl(photo.photoId, tripId)}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            // opacity instead of display:none — lazy loading skips display:none elements
            style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: loaded ? 1 : 0, transition: 'opacity 0.15s' }}
            alt={photo.filename ?? ''}
          />
        )}
        {!loaded && !failed && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
          </div>
        )}
        {failed && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>unavailable</span>
          </div>
        )}
      </div>
      <div style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace', color: '#52525b', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {photo.filename}
      </div>
    </div>
  )
}


function FaceBBoxOverlay({ dims, photo }: { dims: ImgDims; photo: LightboxPhoto }) {
  // Bbox coords are in detection-space: backend resizes to max 1920px long side before running
  // face detection (see pipeline/face.py MAX_LONG_SIDE = 1920). Scale back to natural image coords.
  const MAX_DET_LONG = 1920
  const detLong = Math.max(dims.naturalW, dims.naturalH)
  const detScale = detLong > MAX_DET_LONG ? MAX_DET_LONG / detLong : 1.0

  const sx = dims.displayW / dims.naturalW
  const sy = dims.displayH / dims.naturalH
  const x = dims.displayX + ((photo.bboxX ?? 0) / detScale) * sx
  const y = dims.displayY + ((photo.bboxY ?? 0) / detScale) * sy
  const w = ((photo.bboxW ?? 0) / detScale) * sx
  const h = ((photo.bboxH ?? 0) / detScale) * sy

  return (
    <div style={{
      position: 'absolute',
      left: x, top: y, width: w, height: h,
      border: '2px solid var(--accent)',
      borderRadius: 6,
      boxShadow: '0 0 0 1px rgba(0,0,0,.5)',
      pointerEvents: 'none',
    }} />
  )
}


function SyncBanner({ pendingCount, syncing, syncMsg, onSync, onClearCache }: {
  pendingCount: number
  syncing: boolean
  syncMsg: string | null
  onSync: () => void
  onClearCache: () => void
}) {
  const hasPending = pendingCount > 0

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', background: 'rgba(124,110,248,.04)' }}>
      {syncMsg && (
        <div style={{ fontSize: 11, color: syncMsg.startsWith('✓') ? '#86efac' : '#fca5a5', marginBottom: 8, lineHeight: 1.4 }}>
          {syncMsg}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: hasPending ? 8 : 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: hasPending ? '#fbbf24' : 'var(--text-muted)' }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: hasPending ? '#F59E0B' : 'var(--text-muted)',
          }} />
          {hasPending ? `${pendingCount} pending` : 'Synced'}
        </span>
        {!hasPending && (
          <button
            onClick={onClearCache}
            style={{
              background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
              padding: '4px 8px', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer',
            }}
          >
            Clear Cache
          </button>
        )}
      </div>

      {hasPending && (
        <button
          onClick={onSync}
          disabled={syncing}
          style={{
            width: '100%', padding: '8px 0', borderRadius: 8,
            background: 'var(--accent)', border: 'none',
            color: '#fff', fontSize: 12, fontWeight: 600,
            cursor: syncing ? 'not-allowed' : 'pointer',
            opacity: syncing ? 0.7 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          {syncing ? <><Loader2 size={12} className="animate-spin" /> Syncing…</> : 'Sync to Drive →'}
        </button>
      )}
    </div>
  )
}
