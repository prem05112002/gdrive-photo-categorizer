import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  AlertTriangle, Loader2, FileImage, FileScan,
  Copy, Video, ScanFace, UserCheck, Sparkles, Upload,
  ExternalLink, Trash2, RefreshCw, X, Check, Eye,
} from 'lucide-react'
import { api, type Trip, type IngestionProgress, type ClassifyProgress, type UploadProgress, type ClassifyResults, type BodyProgress } from '../api/client'
import { Topbar } from '../components/Topbar'
import { StatusPill } from '../components/StatusPill'

interface FaceProgress {
  status: 'waiting' | 'loading_model' | 'processing' | 'done' | 'error'
  total: number
  processed: number
  faces_found: number
  group_photos: number
  error?: string
}

const STATUSES_PAST_INGESTION  = ['ingested', 'extracting_faces', 'faces_extracted', 'enrolled', 'classified', 'uploaded', 'body_detecting', 'body_detected']
const STATUSES_PAST_FACES      = ['faces_extracted', 'enrolled', 'classified', 'uploaded', 'body_detecting', 'body_detected']
const STATUSES_PAST_ENROLLMENT = ['enrolled', 'classified', 'uploaded', 'body_detecting', 'body_detected']
const STATUSES_PAST_CLASSIFY   = ['classified', 'uploaded', 'body_detecting', 'body_detected']
const STATUSES_PAST_UPLOAD     = ['uploaded', 'body_detecting', 'body_detected']
const STATUSES_PAST_BODY       = ['body_detected']

export function TripDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [trip, setTrip] = useState<Trip | null>(null)
  const [ingestProgress, setIngestProgress]     = useState<IngestionProgress | null>(null)
  const [faceProgress, setFaceProgress]         = useState<FaceProgress | null>(null)
  const [classifyProgress, setClassifyProgress] = useState<ClassifyProgress | null>(null)
  const [uploadProgress, setUploadProgress]     = useState<UploadProgress | null>(null)
  const [bodyProgress, setBodyProgress] = useState<BodyProgress | null>(null)
  const [ingesting, setIngesting]       = useState(false)
  const [extracting, setExtracting]     = useState(false)
  const [classifying, setClassifying]   = useState(false)
  const [uploading, setUploading]       = useState(false)
  const [bodyDetecting, setBodyDetecting] = useState(false)
  const [faceStats, setFaceStats] = useState<{ total_faces: number; photos_with_faces: number; group_photo_candidates: number } | null>(null)
  const [classifyResults, setClassifyResults] = useState<ClassifyResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const loadTrip = useCallback(async () => {
    if (!id) return
    try {
      const data = await api.trips.get(id)
      setTrip(data)
      if (STATUSES_PAST_FACES.includes(data.status)) {
        const stats = await api.pipeline.faceStats(id)
        setFaceStats(stats)
      }
      if (STATUSES_PAST_CLASSIFY.includes(data.status)) {
        const results = await api.classify.results(id)
        setClassifyResults(results)
      }
    } catch {
      setError('Trip not found')
    }
  }, [id])

  useEffect(() => { loadTrip() }, [loadTrip])

  async function startIngestion() {
    if (!id) return
    setIngesting(true); setError(null)
    try {
      await api.processing.startIngestion(id)
      api.processing.streamProgress(id, setIngestProgress, () => { setIngesting(false); loadTrip() })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start ingestion')
      setIngesting(false)
    }
  }

  async function startFaceExtraction() {
    if (!id) return
    setExtracting(true); setError(null)
    try {
      await api.pipeline.startFaceExtraction(id)
      api.pipeline.streamFaceProgress(id, setFaceProgress, () => { setExtracting(false); loadTrip() })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start face extraction')
      setExtracting(false)
    }
  }

  async function startClassify() {
    if (!id) return
    setClassifying(true); setError(null)
    try {
      await api.classify.run(id)
      api.classify.streamProgress(id, setClassifyProgress, () => { setClassifying(false); loadTrip() })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start classification')
      setClassifying(false)
    }
  }

  async function startUpload() {
    if (!id) return
    setUploading(true); setError(null)
    try {
      await api.classify.upload(id)
      api.classify.streamUploadProgress(id, setUploadProgress, () => { setUploading(false); loadTrip() })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start upload')
      setUploading(false)
    }
  }

  async function startBodyDetection() {
    if (!id) return
    setBodyDetecting(true); setError(null)
    try {
      await api.body.run(id)
      api.body.streamProgress(id, setBodyProgress, () => { setBodyDetecting(false); loadTrip() })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start body detection')
      setBodyDetecting(false)
    }
  }

  async function handleDelete() {
    if (!id) return
    setDeleting(true)
    try {
      await api.trips.delete(id)
      navigate('/')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete trip')
      setDeleting(false)
      setShowDeleteConfirm(false)
    }
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="text-center">
          <AlertTriangle size={28} className="mx-auto mb-3" style={{ color: 'var(--error)' }} />
          <p style={{ color: 'var(--text-muted)' }}>{error}</p>
          <button onClick={() => navigate('/')} className="mt-4 text-sm hover:underline" style={{ color: 'var(--accent)' }}>
            ← Back to trips
          </button>
        </div>
      </div>
    )
  }

  if (!trip) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <Loader2 className="animate-spin" size={24} style={{ color: 'var(--accent)' }} />
      </div>
    )
  }

  const effectiveStatus = trip.status === 'failed' && trip.last_good_status
    ? trip.last_good_status
    : trip.status

  const pastIngestion  = STATUSES_PAST_INGESTION.includes(effectiveStatus)
  const pastFaces      = STATUSES_PAST_FACES.includes(effectiveStatus)
  const pastEnrollment = STATUSES_PAST_ENROLLMENT.includes(effectiveStatus)
  const pastClassify   = STATUSES_PAST_CLASSIFY.includes(effectiveStatus)
  const pastUpload        = STATUSES_PAST_UPLOAD.includes(effectiveStatus)
  const pastBody          = STATUSES_PAST_BODY.includes(effectiveStatus)
  const isIngesting       = ingesting || trip.status === 'ingesting'
  const isExtracting      = extracting || trip.status === 'extracting_faces'
  const isBodyDetecting   = bodyDetecting || trip.status === 'body_detecting'
  const isFailed          = trip.status === 'failed'

  const driveUrl = trip.output_folder_id
    ? `https://drive.google.com/drive/folders/${trip.output_folder_id}`
    : uploadProgress?.output_url ?? null

  const breadcrumbs = [
    { label: trip.name },
  ]

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <Topbar
        breadcrumbs={breadcrumbs}
        actions={
          driveUrl ? (
            <a
              href={driveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm transition-colors"
              style={{ color: 'var(--accent)' }}
            >
              View on Drive <ExternalLink size={12} />
            </a>
          ) : undefined
        }
      />

      {/* Main two-column layout */}
      <div style={{ maxWidth: 1024, margin: '0 auto', display: 'flex', minHeight: 'calc(100vh - 56px)' }}>

        {/* ── Pipeline column ── */}
        <div style={{ flex: '1 1 0', minWidth: 0, padding: '28px 30px' }}>
          <h2 style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)', marginBottom: 22 }}>
            Pipeline
          </h2>

          {/* Error banner */}
          {isFailed && (
            <div
              className="rounded-xl p-4 mb-6 flex items-start gap-3"
              style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.35)' }}
            >
              <div
                style={{ flexShrink: 0, width: 26, height: 26, borderRadius: '50%', background: 'var(--error)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14 }}
              >
                !
              </div>
              <div>
                <p style={{ fontWeight: 700, fontSize: 14, color: '#fca5a5' }}>
                  {trip.error_message?.includes('403') ? 'Extraction failed' : 'Something went wrong'}
                </p>
                {trip.error_message && (
                  <p style={{ fontSize: 13, color: '#f87171', marginTop: 3, lineHeight: 1.4 }}>
                    {trip.error_message}
                  </p>
                )}
                <p style={{ fontSize: 12, color: '#f87171', opacity: 0.7, marginTop: 2 }}>
                  Retry the failed step below.
                </p>
              </div>
            </div>
          )}

          {/* File breakdown stats — only when there's a meaningful multi-type breakdown */}
          {trip.photo_count > 0 && (trip.raw_count > 0 || trip.video_count > 0 || trip.duplicate_count > 0) && (
            <div className="flex flex-wrap gap-2 mb-6">
              <MiniStat icon={<FileImage size={13} />} label="Photos"
                value={trip.photo_count - trip.raw_count - trip.video_count - trip.duplicate_count} />
              {trip.raw_count > 0 && <MiniStat icon={<FileScan size={13} />} label="RAW" value={trip.raw_count} />}
              {trip.video_count > 0 && <MiniStat icon={<Video size={13} />} label="Videos" value={trip.video_count} />}
              {trip.duplicate_count > 0 && <MiniStat icon={<Copy size={13} />} label="Dupes" value={trip.duplicate_count} />}
            </div>
          )}

          {/* Step 1 — Import */}
          <Step num={1} title="Import" done={pastIngestion} active={isIngesting}>
            {ingestProgress && <IngestionProgressBar progress={ingestProgress} />}
            {!pastIngestion && !isIngesting && (
              <button onClick={startIngestion} className="btn-primary">
                Start Ingestion
              </button>
            )}
            {isIngesting && <Spinner label="Ingesting…" />}
            {pastIngestion && !isIngesting && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {trip.photo_count - trip.raw_count - trip.video_count - trip.duplicate_count} photos ingested
                {trip.raw_count > 0 && ` · ${trip.raw_count} RAW skipped`}
                {trip.video_count > 0 && ` · ${trip.video_count} videos skipped`}
                {trip.duplicate_count > 0 && ` · ${trip.duplicate_count} dupes skipped`}
              </p>
            )}
          </Step>

          {/* Step 2 — Extract Faces */}
          <Step num={2} title="Extract Faces" done={pastFaces} active={isExtracting} locked={!pastIngestion}>
            {faceProgress && <FaceProgressBar progress={faceProgress} />}
            {pastIngestion && !pastFaces && !isExtracting && (
              <button onClick={startFaceExtraction} className="btn-primary">
                <ScanFace size={14} /> Extract Faces
              </button>
            )}
            {isExtracting && <Spinner label="Detecting faces…" />}
            {pastFaces && !isExtracting && faceStats && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {faceStats.total_faces} faces · {faceStats.group_photo_candidates} group photo candidates
              </p>
            )}
          </Step>

          {/* Step 3 — Enroll */}
          <Step num={3} title="Enroll" done={pastEnrollment} locked={!pastFaces}>
            {pastFaces && !pastEnrollment && (
              <button onClick={() => navigate(`/trips/${id}/enroll`)} className="btn-primary">
                <UserCheck size={14} /> Start Enrollment
              </button>
            )}
            {pastEnrollment && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Enrolled · people named</span>
                <button
                  onClick={() => navigate(`/trips/${id}/enroll`)}
                  style={{ fontSize: 13, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                >
                  Manage roster →
                </button>
              </div>
            )}
          </Step>

          {/* Step 4 — Classify & Upload */}
          <Step num={4} title="Classify & Upload" done={pastClassify} active={classifying} locked={!pastEnrollment}>
            {classifyProgress && !pastClassify && <ClassifyProgressBar progress={classifyProgress} />}
            {pastEnrollment && !pastClassify && !classifying && (
              <button onClick={startClassify} className="btn-primary">
                <Sparkles size={14} /> Run Classification
              </button>
            )}
            {classifying && <Spinner label="Classifying…" />}
            {pastClassify && classifyResults && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {classifyResults.persons.slice(0, 6).map(p => (
                  <span
                    key={p.person_id}
                    style={{ fontSize: 12, padding: '2px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                  >
                    {p.name} · {p.photo_count}
                  </span>
                ))}
                {classifyResults.persons.length > 6 && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    +{classifyResults.persons.length - 6} more
                  </span>
                )}
              </div>
            )}
          </Step>

          {/* Step 5 — Upload to Drive */}
          <Step num={5} title="Upload to Drive" done={pastUpload} active={uploading} locked={!pastClassify}>
            {uploadProgress && !pastUpload && <UploadProgressBar progress={uploadProgress} />}
            {pastClassify && !pastUpload && !uploading && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Creates shortcuts on Drive — no file copies.</span>
                <button onClick={startUpload} className="btn-primary">
                  <Upload size={14} /> Upload to Drive
                </button>
              </div>
            )}
            {uploading && <Spinner label="Creating shortcuts on Drive…" />}
            {pastUpload && !uploading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {(() => {
                    const n = uploadProgress?.total_shortcuts
                      ?? (classifyResults
                        ? classifyResults.persons.reduce((s, p) => s + p.photo_count, 0)
                          + Object.values(classifyResults.scene_counts).reduce((a, b) => a + b, 0)
                        : null)
                    return n != null ? `${n} shortcuts created` : 'Uploaded'
                  })()}
                </p>
                <button
                  onClick={startUpload}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                  title="Re-upload after corrections (idempotent)"
                >
                  <RefreshCw size={11} /> Re-upload
                </button>
              </div>
            )}
          </Step>

          {/* Step 6 — Body Detection */}
          <Step num={6} title="Body Detection" done={pastBody} active={isBodyDetecting} locked={!pastUpload}>
            {bodyProgress && !pastBody && <BodyProgressBar progress={bodyProgress} />}
            {pastUpload && !pastBody && !isBodyDetecting && (
              <div>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
                  Detects body outlines and computes outfit signatures for each person.
                </p>
                <button onClick={startBodyDetection} className="btn-primary">
                  <Eye size={14} /> Detect Bodies
                </button>
              </div>
            )}
            {isBodyDetecting && <Spinner label="Detecting bodies…" />}
            {pastBody && !isBodyDetecting && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {bodyProgress?.bodies_found != null
                  ? `${bodyProgress.bodies_found} bodies · ${bodyProgress.matched} matched · ${bodyProgress.unmatched} unmatched`
                  : 'Body detection complete'}
              </p>
            )}
          </Step>
        </div>

        {/* ── Sidebar ── */}
        <div style={{ width: 290, flexShrink: 0, borderLeft: '1px solid var(--border)', padding: '28px 24px' }}>
          <div style={{ position: 'sticky', top: 76 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16 }}>
              Trip
            </p>

            {/* Metadata card */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
              <SidebarRow label="Created" value={new Date(trip.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} />
              <SidebarRow label="Photos" value={trip.photo_count > 0 ? String(trip.photo_count) : '—'} />
              <SidebarRow
                label="People"
                value={classifyResults && classifyResults.persons.length > 0
                  ? String(classifyResults.persons.length)
                  : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontWeight: 400 }}>after classify</span>
                }
              />
              <SidebarRow label="Status" value={<StatusPill status={trip.status} />} isLast />
            </div>

            {/* Action buttons */}
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pastClassify && (
                <button
                  onClick={() => navigate(`/trips/${id}/review`)}
                  style={{ width: '100%', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: 11, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
                >
                  Open Review →
                </button>
              )}
              {pastClassify && (
                <button
                  onClick={() => navigate(`/trips/${id}/gallery`)}
                  style={{ width: '100%', background: 'transparent', color: 'var(--accent)', border: '1px solid rgba(124,110,248,.4)', borderRadius: 9, padding: 11, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(124,110,248,.08)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  Gallery →
                </button>
              )}
              <button
                onClick={() => setShowDeleteConfirm(true)}
                style={{ width: '100%', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 9, padding: 11, fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--error)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,.4)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)' }}
              >
                <Trash2 size={13} /> Delete Trip
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div
          onClick={() => setShowDeleteConfirm(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
            background: 'rgba(8,8,11,.55)', backdropFilter: 'blur(1px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 400,
              background: '#1E1E2A', border: '1px solid var(--border)',
              borderRadius: 14, boxShadow: '0 20px 50px rgba(0,0,0,.6)',
              padding: 24,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 17, color: '#F4F4F5' }}>Delete this trip?</div>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#71717A', display: 'flex', alignItems: 'center', padding: 2 }}
              >
                <X size={16} />
              </button>
            </div>
            <div style={{ fontSize: 13, color: '#71717A', marginBottom: 24, lineHeight: 1.5 }}>
              All photos, faces, and enrollment data will be removed from the local registry.
              Your Google Drive is not affected.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                style={{ flex: 1, background: 'transparent', color: '#a1a1aa', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{ flex: 1, background: '#7f1d1d', color: '#fca5a5', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.7 : 1 }}
                onMouseEnter={e => { if (!deleting) e.currentTarget.style.background = '#991b1b' }}
                onMouseLeave={e => { e.currentTarget.style.background = '#7f1d1d' }}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Step component ──────────────────────────────────────────────────────────────

function Step({ num, title, done, active, locked, children }: {
  num: number
  title: string
  done?: boolean
  active?: boolean
  locked?: boolean
  children?: React.ReactNode
}) {
  const isLast = num === 6

  const statusBadge = done ? (
    <span style={{ fontSize: 11, fontWeight: 600, color: '#22C55E' }}>Done</span>
  ) : active ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: '#c4b5fd' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', animation: 'wpulse 1.4s ease-in-out infinite' }} />
      Processing
    </span>
  ) : !locked ? (
    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Pending</span>
  ) : null

  const cardBg     = active ? 'var(--surface)' : done ? 'var(--surface)' : '#101015'
  const cardBorder = active ? '#4c3fb0' : 'var(--border)'
  const hasContent = !locked && !!children

  return (
    <div style={{ display: 'flex', gap: 18, opacity: locked ? 0.4 : 1 }}>
      {/* Circle + vertical connector */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        {active ? (
          <div style={{ position: 'relative', width: 34, height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--accent)', animation: 'wring 1.6s ease-out infinite' }} />
            <div style={{ position: 'relative', width: 34, height: 34, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
              {num}
            </div>
          </div>
        ) : done ? (
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#22C55E', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#06140b', flexShrink: 0 }}>
            <Check size={17} strokeWidth={3} />
          </div>
        ) : (
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--surface)', border: '2px solid #3f3f46', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
            {num}
          </div>
        )}
        {!isLast && (
          <div style={{ width: 2, flex: 1, background: done ? '#1d5b34' : '#27272A', margin: '4px 0', minHeight: 40 }} />
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 34 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: locked ? 'var(--text-muted)' : 'var(--text-primary)' }}>
            {num} · {title}
          </span>
          {statusBadge}
        </div>
        {hasContent && (
          <div style={{ marginTop: 10, background: cardBg, border: `1px solid ${cardBorder}`, borderRadius: 10, padding: '14px 16px' }}>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sidebar helpers ─────────────────────────────────────────────────────────────

function SidebarRow({ label, value, isLast }: { label: string; value: React.ReactNode; isLast?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}

// ── Mini file-type stat badge ────────────────────────────────────────────────────

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: 72 }}>
      <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
        {icon} {label}
      </div>
      <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
    </div>
  )
}

// ── Spinner ──────────────────────────────────────────────────────────────────────

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
      <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent)' }} />
      {label}
    </div>
  )
}

// ── Progress bars ────────────────────────────────────────────────────────────────

function IngestionProgressBar({ progress }: { progress: IngestionProgress }) {
  const total = progress.total_files || 1
  const pct   = Math.round((progress.processed / total) * 100)
  const label: Record<string, string> = {
    listing:     'Listing files…',
    downloading: `Downloading ${progress.downloaded} / ${progress.total_files}`,
    processing:  `Processing ${progress.processed} / ${progress.total_files}`,
    done:        'Complete',
    error:       progress.error ?? 'Error',
  }
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
        <span>{label[progress.status] ?? progress.status}</span>
        <span>{pct}%</span>
      </div>
      <ProgressBar pct={pct} error={progress.status === 'error'} />
      {progress.status === 'error' && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--error)' }}>{progress.error}</p>
      )}
    </div>
  )
}

function FaceProgressBar({ progress }: { progress: FaceProgress }) {
  const total = progress.total || 1
  const pct   = Math.round((progress.processed / total) * 100)
  const label: Record<string, string> = {
    waiting:       'Waiting…',
    loading_model: 'Loading model (downloads ~235 MB on first run)…',
    processing:    `${progress.processed} / ${progress.total} photos — ${progress.faces_found} faces found`,
    done:          'Complete',
    error:         progress.error ?? 'Error',
  }
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
        <span className="truncate max-w-xs">{label[progress.status] ?? progress.status}</span>
        <span className="shrink-0 ml-2">{pct}%</span>
      </div>
      <ProgressBar pct={pct} error={progress.status === 'error'} />
      {progress.status === 'error' && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--error)' }}>{progress.error}</p>
      )}
    </div>
  )
}

function ClassifyProgressBar({ progress }: { progress: ClassifyProgress }) {
  const stepLabel: Record<string, string> = {
    face_match:          'Matching faces to registry…',
    loading_scene_model: 'Loading scene model (downloads ~150 MB on first run)…',
    scene_classify:      progress.scene_total
      ? `Scene classifying ${progress.scene_processed ?? 0} / ${progress.scene_total} photos…`
      : 'Classifying scenes…',
  }
  const pct = progress.step === 'scene_classify' && progress.scene_total
    ? Math.round(((progress.scene_processed ?? 0) / progress.scene_total) * 100)
    : progress.step === 'face_match' ? 50 : 10

  return (
    <div>
      <div className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
        {stepLabel[progress.step ?? ''] ?? 'Running…'}
      </div>
      <ProgressBar pct={pct} error={progress.status === 'error'} />
      {progress.status === 'error' && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--error)' }}>{progress.error}</p>
      )}
    </div>
  )
}

function UploadProgressBar({ progress }: { progress: UploadProgress }) {
  const total = progress.total || 1
  const pct   = Math.round(((progress.uploaded ?? 0) / total) * 100)
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
        <span className="truncate max-w-xs">{progress.current ?? 'Uploading…'}</span>
        <span className="shrink-0 ml-2">{progress.uploaded ?? 0} / {total}</span>
      </div>
      <ProgressBar pct={pct} error={progress.status === 'error'} />
      {progress.status === 'error' && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--error)' }}>{progress.error}</p>
      )}
    </div>
  )
}

function BodyProgressBar({ progress }: { progress: BodyProgress }) {
  const pct = progress.step === 'detecting' && progress.total
    ? Math.round(((progress.processed ?? 0) / progress.total) * 100)
    : progress.step === 'loading_model' ? 5 : 0
  const label = progress.step === 'loading_model'
    ? 'Loading model (downloads ~140 MB on first run)…'
    : progress.step === 'detecting' && progress.total
      ? `Detecting bodies ${progress.processed ?? 0} / ${progress.total} photos…`
      : 'Running…'
  return (
    <div>
      <div className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <ProgressBar pct={pct} error={progress.status === 'error'} />
      {progress.status === 'error' && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--error)' }}>{progress.error}</p>
      )}
    </div>
  )
}

function ProgressBar({ pct, error }: { pct: number; error?: boolean }) {
  return (
    <div className="h-2 rounded-full overflow-hidden" style={{ background: '#26233a' }}>
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{ width: `${pct}%`, background: error ? 'var(--error)' : 'var(--accent)' }}
      />
    </div>
  )
}
