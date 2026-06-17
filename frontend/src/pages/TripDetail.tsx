import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Play, CheckCircle, AlertCircle, Loader2, FileImage, FileScan, Copy, Video, ScanFace, Users, UserCheck, Sparkles, Upload, ExternalLink, Trash2, RefreshCw } from 'lucide-react'
import { api, type Trip, type IngestionProgress, type ClassifyProgress, type UploadProgress, type ClassifyResults } from '../api/client'

interface FaceProgress {
  status: 'waiting' | 'loading_model' | 'processing' | 'done' | 'error'
  total: number
  processed: number
  faces_found: number
  group_photos: number
  error?: string
}

const STATUSES_PAST_INGESTION  = ['ingested', 'extracting_faces', 'faces_extracted', 'enrolled', 'classified', 'uploaded']
const STATUSES_PAST_FACES      = ['faces_extracted', 'enrolled', 'classified', 'uploaded']
const STATUSES_PAST_ENROLLMENT = ['enrolled', 'classified', 'uploaded']
const STATUSES_PAST_CLASSIFY   = ['classified', 'uploaded']
const STATUSES_PAST_UPLOAD     = ['uploaded']

export function TripDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [trip, setTrip] = useState<Trip | null>(null)
  const [ingestProgress, setIngestProgress] = useState<IngestionProgress | null>(null)
  const [faceProgress, setFaceProgress] = useState<FaceProgress | null>(null)
  const [classifyProgress, setClassifyProgress] = useState<ClassifyProgress | null>(null)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [ingesting, setIngesting] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [uploading, setUploading] = useState(false)
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
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="text-red-400 mx-auto mb-3" size={32} />
          <p className="text-zinc-400">{error}</p>
          <button onClick={() => navigate('/')} className="mt-4 text-violet-400 text-sm hover:underline">← Back to trips</button>
        </div>
      </div>
    )
  }

  if (!trip) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="text-violet-400 animate-spin" size={28} />
      </div>
    )
  }

  // When a trip has failed, use last_good_status to determine which steps completed
  const effectiveStatus = trip.status === 'failed' && trip.last_good_status
    ? trip.last_good_status
    : trip.status

  const pastIngestion  = STATUSES_PAST_INGESTION.includes(effectiveStatus)
  const pastFaces      = STATUSES_PAST_FACES.includes(effectiveStatus)
  const pastEnrollment = STATUSES_PAST_ENROLLMENT.includes(effectiveStatus)
  const pastClassify   = STATUSES_PAST_CLASSIFY.includes(effectiveStatus)
  const pastUpload     = STATUSES_PAST_UPLOAD.includes(trip.status)  // only actual "uploaded" status
  const isIngesting    = ingesting || trip.status === 'ingesting'
  const isExtracting   = extracting || trip.status === 'extracting_faces'
  const isFailed       = trip.status === 'failed'

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-3xl mx-auto px-6 py-10">

        <div className="flex items-center justify-between mb-8">
          <button onClick={() => navigate('/')} className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
            <ArrowLeft size={16} /> All trips
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center gap-1.5 text-zinc-600 hover:text-red-400 text-sm transition-colors"
          >
            <Trash2 size={14} /> Delete trip
          </button>
        </div>

        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">{trip.name}</h1>
          <p className="text-zinc-500 text-sm">
            Folder ID: <code className="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">{trip.drive_folder_id}</code>
          </p>
        </div>

        {/* Error banner */}
        {isFailed && (
          <div className="bg-red-950/50 border border-red-900 rounded-xl p-4 mb-6 flex items-start gap-3">
            <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-red-300 text-sm font-medium">Something went wrong</p>
              {trip.error_message && (
                <p className="text-red-400/70 text-xs mt-1 font-mono break-all">{trip.error_message}</p>
              )}
              <p className="text-red-500/60 text-xs mt-1">Retry the failed step below.</p>
            </div>
          </div>
        )}

        {/* Stats */}
        {trip.photo_count > 0 && (
          <div className="grid grid-cols-4 gap-3 mb-8">
            <StatCard icon={<FileImage size={18} />} label="Photos" value={trip.photo_count - trip.raw_count - trip.video_count - trip.duplicate_count} />
            <StatCard icon={<FileScan size={18} />}  label="RAW"    value={trip.raw_count} />
            <StatCard icon={<Video size={18} />}     label="Videos" value={trip.video_count} />
            <StatCard icon={<Copy size={18} />}      label="Dupes"  value={trip.duplicate_count} />
          </div>
        )}

        {/* ── Step 1: Ingest ── */}
        <StepCard step={1} title="Ingest" description="Download photos, separate RAW/video, deduplicate, extract EXIF." done={pastIngestion}>
          {ingestProgress && <IngestionProgressBar progress={ingestProgress} />}
          {!pastIngestion && !isIngesting && (
            <button onClick={startIngestion} className="btn-primary"><Play size={15} /> Start Ingestion</button>
          )}
          {isIngesting && <Spinner label="Ingesting…" />}
          {pastIngestion && !isIngesting && <DoneTag label={`${trip.photo_count} files ingested`} />}
        </StepCard>

        {/* ── Step 2: Extract Faces ── */}
        <StepCard step={2} title="Extract Faces" description="Detect every face in every photo and compute 512-dim embeddings." done={pastFaces} locked={!pastIngestion}>
          {faceProgress && <FaceProgressBar progress={faceProgress} />}
          {pastIngestion && !pastFaces && !isExtracting && (
            <button onClick={startFaceExtraction} className="btn-primary"><ScanFace size={15} /> Extract Faces</button>
          )}
          {isExtracting && <Spinner label="Detecting faces…" />}
          {pastFaces && !isExtracting && faceStats && (
            <div className="flex gap-5 text-sm text-emerald-400">
              <DoneTag label={`${faceStats.total_faces} faces found`} />
              <span className="text-zinc-500 flex items-center gap-1.5">
                <Users size={13} /> {faceStats.group_photo_candidates} group photo candidates
              </span>
            </div>
          )}
        </StepCard>

        {/* ── Step 3: Enroll ── */}
        <StepCard step={3} title="Enroll" description="Identify group members and build the known-faces registry." done={pastEnrollment} locked={!pastFaces}>
          {pastFaces && !pastEnrollment && (
            <button onClick={() => navigate(`/trips/${id}/enroll`)} className="btn-primary">
              <UserCheck size={15} /> Start Enrollment
            </button>
          )}
          {pastEnrollment && (
            <div className="flex items-center gap-4">
              <DoneTag label="Enrolled" />
              <button onClick={() => navigate(`/trips/${id}/enroll`)} className="text-sm text-zinc-400 hover:text-white transition-colors">
                Manage roster →
              </button>
            </div>
          )}
        </StepCard>

        {/* ── Step 4: Classify ── */}
        <StepCard step={4} title="Classify" description="Match each face to a registered person using FAISS. Label no-face photos by scene (beach, temple, street…)." done={pastClassify} locked={!pastEnrollment}>
          {classifyProgress && !pastClassify && <ClassifyProgressBar progress={classifyProgress} />}
          {pastEnrollment && !pastClassify && !classifying && (
            <button onClick={startClassify} className="btn-primary">
              <Sparkles size={15} /> Run Classification
            </button>
          )}
          {classifying && <Spinner label="Classifying…" />}
          {pastClassify && classifyResults && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {classifyResults.persons.slice(0, 5).map(p => (
                  <span key={p.person_id} className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded">
                    {p.name} · {p.photo_count} photos
                  </span>
                ))}
                {classifyResults.persons.length > 5 && (
                  <span className="text-xs text-zinc-600">+{classifyResults.persons.length - 5} more</span>
                )}
              </div>
              {Object.keys(classifyResults.scene_counts).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(classifyResults.scene_counts).map(([label, count]) => (
                    <span key={label} className="text-xs bg-zinc-800 text-zinc-400 px-2 py-1 rounded capitalize">
                      {label} · {count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </StepCard>

        {/* ── Delete confirmation ── */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-sm w-full">
              <h3 className="text-white font-semibold mb-2">Delete this trip?</h3>
              <p className="text-zinc-400 text-sm mb-6">
                All photos, faces, and enrollment data will be removed from the local registry.
                Your Google Drive is not affected.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-zinc-700 text-zinc-300 text-sm hover:bg-zinc-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                >
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 5: Upload to Drive ── */}
        <StepCard step={5} title="Upload to Drive" description="Create organized folder structure on Drive and write shortcuts for every photo." done={pastUpload} locked={!pastClassify}>
          {uploadProgress && !pastUpload && <UploadProgressBar progress={uploadProgress} />}
          {pastClassify && !pastUpload && !uploading && (
            <button onClick={startUpload} className="btn-primary">
              <Upload size={15} /> Upload to Drive
            </button>
          )}
          {uploading && <Spinner label="Creating shortcuts on Drive…" />}
          {pastUpload && !uploading && (
            <div className="flex items-center gap-4 flex-wrap">
              <DoneTag label={(() => {
                const n = uploadProgress?.total_shortcuts
                  ?? (classifyResults
                    ? classifyResults.persons.reduce((s, p) => s + p.photo_count, 0)
                      + Object.values(classifyResults.scene_counts).reduce((a, b) => a + b, 0)
                    : null)
                return n != null ? `${n} shortcuts created` : 'Uploaded'
              })()} />
              {(trip.output_folder_id || uploadProgress?.output_url) && (
                <a
                  href={trip.output_folder_id
                    ? `https://drive.google.com/drive/folders/${trip.output_folder_id}`
                    : uploadProgress?.output_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-violet-400 hover:text-violet-300 transition-colors"
                >
                  View on Drive <ExternalLink size={13} />
                </a>
              )}
              <button
                onClick={() => navigate(`/trips/${id}/review`)}
                className="text-sm text-zinc-400 hover:text-white transition-colors"
              >
                Review →
              </button>
              <button
                onClick={startUpload}
                className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                title="Re-upload after corrections (idempotent — no duplicate shortcuts)"
              >
                <RefreshCw size={12} /> Re-upload
              </button>
            </div>
          )}
        </StepCard>

      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StepCard({ step, title, description, done, locked, children }: {
  step: number; title: string; description: string
  done?: boolean; locked?: boolean; children?: React.ReactNode
}) {
  return (
    <div className={`rounded-xl border p-6 mb-4 transition-colors ${
      locked ? 'bg-zinc-950 border-zinc-900 opacity-50' :
      done   ? 'bg-zinc-900 border-zinc-700' :
               'bg-zinc-900 border-zinc-800'
    }`}>
      <div className="flex items-center gap-3 mb-1">
        <span className="text-xs font-mono text-zinc-600">0{step}</span>
        <h2 className="text-white font-semibold">{title}</h2>
        {done && <CheckCircle size={15} className="text-emerald-400 ml-auto" />}
      </div>
      <p className="text-zinc-500 text-sm mb-4">{description}</p>
      {!locked && children}
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center gap-2 text-zinc-500 text-xs mb-2">{icon}{label}</div>
      <p className="text-white text-2xl font-bold">{value}</p>
    </div>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-zinc-400 text-sm">
      <Loader2 size={16} className="animate-spin text-violet-400" />{label}
    </div>
  )
}

function DoneTag({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-emerald-400 text-sm">
      <CheckCircle size={15} />{label}
    </div>
  )
}

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
    <div className="mb-4">
      <div className="flex justify-between text-xs text-zinc-500 mb-1.5">
        <span>{label[progress.status] ?? progress.status}</span><span>{pct}%</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-300 ${progress.status === 'error' ? 'bg-red-500' : 'bg-violet-500'}`}
             style={{ width: `${pct}%` }} />
      </div>
      {progress.status === 'done' && (
        <div className="flex gap-4 mt-2 text-xs text-zinc-500">
          <span className="text-emerald-400">✓ {progress.total_files} files</span>
          {progress.raw_count > 0 && <span>{progress.raw_count} RAW</span>}
          {progress.video_count > 0 && <span>{progress.video_count} videos</span>}
          {progress.duplicate_count > 0 && <span>{progress.duplicate_count} dupes skipped</span>}
        </div>
      )}
      {progress.status === 'error' && <p className="mt-1.5 text-xs text-red-400">{progress.error}</p>}
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
    <div className="mb-4">
      <div className="flex justify-between text-xs text-zinc-500 mb-1.5">
        <span>{label[progress.status] ?? progress.status}</span><span>{pct}%</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-300 ${progress.status === 'error' ? 'bg-red-500' : 'bg-violet-500'}`}
             style={{ width: `${pct}%` }} />
      </div>
      {progress.status === 'error' && <p className="mt-1.5 text-xs text-red-400">{progress.error}</p>}
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
    <div className="mb-4">
      <div className="text-xs text-zinc-500 mb-1.5">
        {stepLabel[progress.step ?? ''] ?? 'Running…'}
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-violet-500 transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      {progress.status === 'error' && <p className="mt-1.5 text-xs text-red-400">{progress.error}</p>}
    </div>
  )
}

function UploadProgressBar({ progress }: { progress: UploadProgress }) {
  const total = progress.total || 1
  const pct   = Math.round(((progress.uploaded ?? 0) / total) * 100)
  return (
    <div className="mb-4">
      <div className="flex justify-between text-xs text-zinc-500 mb-1.5">
        <span className="truncate max-w-xs">{progress.current ?? 'Uploading…'}</span>
        <span>{progress.uploaded ?? 0} / {total}</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-300 ${progress.status === 'error' ? 'bg-red-500' : 'bg-violet-500'}`}
             style={{ width: `${pct}%` }} />
      </div>
      {progress.status === 'error' && <p className="mt-1.5 text-xs text-red-400">{progress.error}</p>}
    </div>
  )
}
