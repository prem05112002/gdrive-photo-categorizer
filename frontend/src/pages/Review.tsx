import { useState, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { ExternalLink, UserX, Loader2, MapPin, ScanSearch } from 'lucide-react'
import { api, type ClassifyResults, type MiscCluster, type OutfitMatch, type Misclassification } from '../api/client'
import { Topbar } from '../components/Topbar'

type Tab = 'misc' | 'outfit' | 'verify'

export function Review() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [tripName, setTripName]             = useState('')
  const [outputFolderId, setOutputFolderId] = useState<string | null>(null)
  const [results, setResults]               = useState<ClassifyResults | null>(null)
  const [miscClusters, setMiscClusters]     = useState<MiscCluster[]>([])
  const [miscFacesCount, setMiscFacesCount] = useState(0)
  const [clusterActing, setClusterActing]   = useState<Set<number>>(new Set())
  const [loading, setLoading]               = useState(true)
  const [error, setError]                   = useState<string | null>(null)
  const [activeTab, setActiveTab]           = useState<Tab>('misc')

  // Outfit matches tab
  const [outfitMatches, setOutfitMatches]   = useState<OutfitMatch[]>([])
  const [outfitIdx, setOutfitIdx]           = useState(0)
  const [outfitActing, setOutfitActing]     = useState(false)
  const [outfitPickerPersonId, setOutfitPickerPersonId] = useState<string>('')
  const [showOutfitPicker, setShowOutfitPicker] = useState(false)

  // Verify these tab
  const [misclassifications, setMisclassifications] = useState<Misclassification[]>([])
  const [verifyIdx, setVerifyIdx]           = useState(0)
  const [verifyActing, setVerifyActing]     = useState(false)
  const [analysisRan, setAnalysisRan]       = useState<boolean | null>(null)
  const [runningAnalysis, setRunningAnalysis] = useState(false)
  const [similarityThreshold, setSimilarityThreshold] = useState(0.55)
  const [margin, setMargin]                 = useState(0.12)

  useEffect(() => {
    if (!id) return
    const load = async () => {
      try {
        const [trip, res, clustersRes, outfitRes, misclassRes] = await Promise.all([
          api.trips.get(id),
          api.classify.results(id),
          api.review.miscClusters(id),
          api.body.outfitMatches(id),
          api.body.misclassifications(id),
        ])
        setTripName(trip.name)
        setOutputFolderId(trip.output_folder_id)
        setResults(res)
        setMiscClusters(clustersRes.clusters)
        setMiscFacesCount(clustersRes.total_faces)
        setOutfitMatches(outfitRes)
        setMisclassifications(misclassRes)
        if (misclassRes.length > 0) setAnalysisRan(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load review')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  async function reloadMiscClusters() {
    if (!id) return
    const res = await api.review.miscClusters(id)
    setMiscClusters(res.clusters)
    setMiscFacesCount(res.total_faces)
  }

  async function assignCluster(clusterId: number, faceIds: string[], personId: string) {
    if (!id) return
    setClusterActing(s => new Set(s).add(clusterId))
    try {
      await api.review.bulkAssign(id, faceIds, personId)
      await reloadMiscClusters()
      const newResults = await api.classify.results(id)
      setResults(newResults)
    } catch { /* ignore */ } finally {
      setClusterActing(s => { const n = new Set(s); n.delete(clusterId); return n })
    }
  }

  async function createFromCluster(clusterId: number, faceIds: string[], name: string) {
    if (!id) return
    setClusterActing(s => new Set(s).add(clusterId))
    try {
      await api.enrollment.nameCluster(id, name, faceIds)
      await reloadMiscClusters()
      const newResults = await api.classify.results(id)
      setResults(newResults)
    } catch { /* ignore */ } finally {
      setClusterActing(s => { const n = new Set(s); n.delete(clusterId); return n })
    }
  }

  async function dismissClusterFaces(clusterId: number, faceIds: string[]) {
    if (!id) return
    setClusterActing(s => new Set(s).add(clusterId))
    try {
      await api.review.bulkDismiss(id, faceIds)
      await reloadMiscClusters()
    } catch { /* ignore */ } finally {
      setClusterActing(s => { const n = new Set(s); n.delete(clusterId); return n })
    }
  }

  async function dismissAllSingletons() {
    if (!id) return
    const faceIds = miscClusters.filter(c => c.size === 1).flatMap(c => c.face_ids)
    if (!faceIds.length) return
    try {
      await api.review.bulkDismiss(id, faceIds)
      await reloadMiscClusters()
    } catch { /* ignore */ }
  }

  async function confirmOutfitMatch(umId: string, personId?: string) {
    if (!id) return
    setOutfitActing(true)
    try {
      await api.body.confirmOutfitMatch(id, umId, personId)
      setOutfitMatches(m => m.filter(x => x.id !== umId))
      setOutfitIdx(i => Math.min(i, outfitMatches.length - 2))
      setShowOutfitPicker(false)
      setOutfitPickerPersonId('')
    } catch { /* ignore */ } finally {
      setOutfitActing(false)
    }
  }

  async function dismissOutfitMatch(umId: string) {
    if (!id) return
    setOutfitActing(true)
    try {
      await api.body.dismissOutfitMatch(id, umId)
      setOutfitMatches(m => m.filter(x => x.id !== umId))
      setOutfitIdx(i => Math.min(i, outfitMatches.length - 2))
      setShowOutfitPicker(false)
      setOutfitPickerPersonId('')
    } catch { /* ignore */ } finally {
      setOutfitActing(false)
    }
  }

  async function runOutfitAnalysis() {
    if (!id) return
    flushSync(() => setRunningAnalysis(true))
    try {
      await api.body.detectMisclassifications(id, similarityThreshold, margin)
      setAnalysisRan(true)
      const updated = await api.body.misclassifications(id)
      setMisclassifications(updated)
    } catch { /* ignore */ } finally {
      setRunningAnalysis(false)
    }
  }

  async function keepClassification(pmId: string) {
    if (!id) return
    setVerifyActing(true)
    try {
      await api.body.keepClassification(id, pmId)
      setMisclassifications(m => m.filter(x => x.id !== pmId))
      setVerifyIdx(i => Math.min(i, misclassifications.length - 2))
    } catch { /* ignore */ } finally {
      setVerifyActing(false)
    }
  }

  async function reassignMisclassification(pmId: string) {
    if (!id) return
    setVerifyActing(true)
    try {
      await api.body.reassignMisclassification(id, pmId)
      setMisclassifications(m => m.filter(x => x.id !== pmId))
      setVerifyIdx(i => Math.min(i, misclassifications.length - 2))
      const newResults = await api.classify.results(id)
      setResults(newResults)
    } catch { /* ignore */ } finally {
      setVerifyActing(false)
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <Loader2 className="animate-spin" size={24} style={{ color: 'var(--accent)' }} />
      </div>
    )
  }

  if (error || !results) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>{error ?? 'Failed to load review'}</p>
          <button onClick={() => navigate(-1)} style={{ fontSize: 13, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>← Go back</button>
        </div>
      </div>
    )
  }

  const totalScenePhotos = Object.values(results.scene_counts).reduce((a, b) => a + b, 0)

  const breadcrumbs = [
    { label: tripName, href: `/trips/${id}` },
    { label: 'Review' },
  ]

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Topbar
        breadcrumbs={breadcrumbs}
        backHref={`/trips/${id}`}
        actions={
          outputFolderId ? (
            <a
              href={`https://drive.google.com/drive/folders/${outputFolderId}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}
            >
              Drive <ExternalLink size={12} />
            </a>
          ) : undefined
        }
      />

      <div style={{ display: 'flex', flex: 1, minHeight: 520 }}>

        {/* ── Left: Confirmed persons ── */}
        <div style={{ width: 210, flexShrink: 0, borderRight: '1px solid var(--border)', padding: '22px 18px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#71717A', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
            Confirmed
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {results.persons.map((p, idx) => (
              <div
                key={p.person_id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: 7, borderRadius: 8,
                  background: idx === 0 ? 'var(--surface)' : 'transparent',
                }}
              >
                <img
                  src={`/api/persons/${p.person_id}/thumbnail`}
                  alt={p.name}
                  style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, background: 'var(--surface)' }}
                  onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </span>
                <span style={{ fontSize: 11, fontWeight: 500, color: '#71717A', flexShrink: 0 }}>{p.photo_count}</span>
              </div>
            ))}
          </div>

          {totalScenePhotos > 0 && (
            <>
              <div style={{ height: 1, background: 'var(--border)', margin: '14px 0' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 7 }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <MapPin size={14} style={{ color: 'var(--text-muted)' }} />
                </div>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Places</span>
                <span style={{ fontSize: 11, fontWeight: 500, color: '#71717A' }}>{totalScenePhotos}</span>
              </div>
            </>
          )}
        </div>

        {/* ── Right: Tabs + queue ── */}
        <div style={{ flex: 1, minWidth: 0, padding: '22px 26px' }}>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
            <TabButton label="Misc Faces" count={miscFacesCount} active={activeTab === 'misc'} onClick={() => setActiveTab('misc')} />
            <TabButton label="Outfit Matches" count={outfitMatches.length} active={activeTab === 'outfit'} onClick={() => setActiveTab('outfit')} />
            <TabButton label="Verify These" count={misclassifications.length} active={activeTab === 'verify'} onClick={() => setActiveTab('verify')} />
          </div>

          {/* Queue */}
          {activeTab === 'misc' && (
            <MiscClusterList
              clusters={miscClusters}
              totalFaces={miscFacesCount}
              persons={results.persons}
              clusterActing={clusterActing}
              onAssign={assignCluster}
              onCreate={createFromCluster}
              onDismiss={dismissClusterFaces}
              onDismissAllSingletons={dismissAllSingletons}
            />
          )}

          {activeTab === 'outfit' && (
            <OutfitMatchesQueue
              tripId={id!}
              matches={outfitMatches}
              queueIdx={outfitIdx}
              setQueueIdx={setOutfitIdx}
              persons={results.persons}
              acting={outfitActing}
              showPicker={showOutfitPicker}
              setShowPicker={setShowOutfitPicker}
              pickerPersonId={outfitPickerPersonId}
              setPickerPersonId={setOutfitPickerPersonId}
              onConfirm={confirmOutfitMatch}
              onDismiss={dismissOutfitMatch}
            />
          )}

          {activeTab === 'verify' && (
            <VerifyQueue
              misclassifications={misclassifications}
              queueIdx={verifyIdx}
              setQueueIdx={setVerifyIdx}
              acting={verifyActing}
              analysisRan={analysisRan}
              runningAnalysis={runningAnalysis}
              similarityThreshold={similarityThreshold}
              setSimilarityThreshold={setSimilarityThreshold}
              margin={margin}
              setMargin={setMargin}
              onRunAnalysis={runOutfitAnalysis}
              onKeep={keepClassification}
              onReassign={reassignMisclassification}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Outfit Matches queue ────────────────────────────────────────────────────────

function OutfitMatchesQueue({
  tripId, matches, queueIdx, setQueueIdx, persons, acting,
  showPicker, setShowPicker, pickerPersonId, setPickerPersonId,
  onConfirm, onDismiss,
}: {
  tripId: string
  matches: OutfitMatch[]
  queueIdx: number
  setQueueIdx: (fn: (i: number) => number) => void
  persons: { name: string; person_id: string; photo_count: number }[]
  acting: boolean
  showPicker: boolean
  setShowPicker: (v: boolean) => void
  pickerPersonId: string
  setPickerPersonId: (id: string) => void
  onConfirm: (umId: string, personId?: string) => void
  onDismiss: (umId: string) => void
}) {
  if (matches.length === 0) {
    return (
      <div style={{ paddingTop: 64, textAlign: 'center' }}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No outfit suggestions to review.</p>
      </div>
    )
  }

  const match = matches[queueIdx]
  if (!match) return null

  const pickerPerson = persons.find(p => p.person_id === pickerPersonId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#a1a1aa' }}>Match {queueIdx + 1} of {matches.length}</span>
        {queueIdx < matches.length - 1 && (
          <button onClick={() => setQueueIdx(i => i + 1)} style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>
            Skip →
          </button>
        )}
      </div>

      {/* Body crop */}
      <img
        src={api.body.unmatchedCropUrl(tripId, match.id)}
        alt="Body"
        style={{ maxWidth: 230, maxHeight: 340, borderRadius: 14, objectFit: 'cover', border: '1px solid var(--border)', background: 'var(--surface)' }}
      />
      <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', color: '#71717A', marginTop: 10 }}>
        {match.photo_name ?? '—'}
      </div>

      {match.suggestion_confidence && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#a1a1aa' }}>
          Outfit similarity: {Math.round(match.suggestion_confidence * 100)}%
        </div>
      )}

      <div style={{ width: '100%', maxWidth: 560, marginTop: 22 }}>
        {!showPicker ? (
          <>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 18, textAlign: 'center' }}>
              Does this look like <span style={{ color: 'var(--accent)' }}>{match.suggested_person_name}</span>?
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={() => onConfirm(match.id)}
                disabled={acting}
                style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: acting ? 0.7 : 1 }}
              >
                {acting ? '…' : `Yes, it's ${match.suggested_person_name}`}
              </button>
              <button
                onClick={() => setShowPicker(true)}
                style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                Different person
              </button>
            </div>
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                onClick={() => onDismiss(match.id)}
                disabled={acting}
                style={{ fontSize: 13, color: '#71717A', textDecoration: 'underline', background: 'none', border: 'none', cursor: acting ? 'not-allowed' : 'pointer', opacity: acting ? 0.5 : 1 }}
              >
                Dismiss (not a group member)
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12, textAlign: 'center' }}>Who is this?</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 18 }}>
              {persons.map(p => {
                const isSel = p.person_id === pickerPersonId
                return (
                  <button
                    key={p.person_id}
                    onClick={() => setPickerPersonId(isSel ? '' : p.person_id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                      background: isSel ? 'rgba(124,110,248,.16)' : 'var(--surface)',
                      border: `1px solid ${isSel ? '#7C6EF8' : 'var(--border)'}`,
                      borderRadius: 30, padding: '5px 14px 5px 5px', cursor: 'pointer',
                    }}
                  >
                    <img
                      src={`/api/persons/${p.person_id}/thumbnail`}
                      alt={p.name}
                      style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', background: 'var(--border)' }}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</span>
                  </button>
                )
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              {pickerPersonId && (
                <button
                  onClick={() => onConfirm(match.id, pickerPersonId)}
                  disabled={acting}
                  style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: acting ? 0.7 : 1 }}
                >
                  {acting ? '…' : `Confirm → ${pickerPerson?.name ?? ''}`}
                </button>
              )}
              <button
                onClick={() => { setShowPicker(false); setPickerPersonId('') }}
                style={{ background: 'transparent', color: '#a1a1aa', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>

      {matches.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 24 }}>
          <button
            onClick={() => setQueueIdx(i => Math.max(0, i - 1))}
            disabled={queueIdx === 0}
            style={{ fontSize: 13, fontWeight: 600, color: '#71717A', background: 'none', border: 'none', cursor: queueIdx === 0 ? 'not-allowed' : 'pointer', opacity: queueIdx === 0 ? 0.3 : 1 }}
          >
            ← Prev
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            {matches.slice(0, Math.min(8, matches.length)).map((_, i) => (
              <button
                key={i}
                onClick={() => setQueueIdx(() => i)}
                style={{ width: 7, height: 7, borderRadius: '50%', background: i === queueIdx ? 'var(--accent)' : 'var(--border)', border: 'none', cursor: 'pointer', padding: 0 }}
              />
            ))}
            {matches.length > 8 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>…</span>}
          </div>
          <button
            onClick={() => setQueueIdx(i => Math.min(matches.length - 1, i + 1))}
            disabled={queueIdx === matches.length - 1}
            style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: queueIdx === matches.length - 1 ? 'not-allowed' : 'pointer', opacity: queueIdx === matches.length - 1 ? 0.3 : 1 }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

// ── Threshold sliders ───────────────────────────────────────────────────────────

function ThresholdSliders({
  similarityThreshold, setSimilarityThreshold, margin, setMargin,
}: {
  similarityThreshold: number
  setSimilarityThreshold: (v: number) => void
  margin: number
  setMargin: (v: number) => void
}) {
  return (
    <div style={{ display: 'block', textAlign: 'left', marginBottom: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 20px', minWidth: 280 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Min outfit match</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'ui-monospace, monospace' }}>{similarityThreshold.toFixed(2)}</span>
        </div>
        <input
          type="range" min={0.3} max={0.9} step={0.05}
          value={similarityThreshold}
          onChange={e => setSimilarityThreshold(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--accent)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>sensitive</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>strict</span>
        </div>
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Min confidence margin</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'ui-monospace, monospace' }}>{margin.toFixed(2)}</span>
        </div>
        <input
          type="range" min={0.0} max={0.4} step={0.02}
          value={margin}
          onChange={e => setMargin(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--accent)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>more flags</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>fewer flags</span>
        </div>
      </div>
    </div>
  )
}

// ── Verify These queue ──────────────────────────────────────────────────────────

function VerifyQueue({
  misclassifications, queueIdx, setQueueIdx, acting,
  analysisRan, runningAnalysis,
  similarityThreshold, setSimilarityThreshold, margin, setMargin,
  onRunAnalysis, onKeep, onReassign,
}: {
  misclassifications: Misclassification[]
  queueIdx: number
  setQueueIdx: (fn: (i: number) => number) => void
  acting: boolean
  analysisRan: boolean | null
  runningAnalysis: boolean
  similarityThreshold: number
  setSimilarityThreshold: (v: number) => void
  margin: number
  setMargin: (v: number) => void
  onRunAnalysis: () => void
  onKeep: (pmId: string) => void
  onReassign: (pmId: string) => void
}) {
  if (!analysisRan && misclassifications.length === 0) {
    return (
      <div style={{ paddingTop: 64, textAlign: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--surface)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <ScanSearch size={22} style={{ color: 'var(--text-muted)' }} />
        </div>
        <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Run outfit analysis</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 22, maxWidth: 340, margin: '0 auto 22px' }}>
          Checks whether any face assignments might be wrong based on outfit colors.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <ThresholdSliders
            similarityThreshold={similarityThreshold}
            setSimilarityThreshold={setSimilarityThreshold}
            margin={margin}
            setMargin={setMargin}
          />
          <button
            onClick={onRunAnalysis}
            disabled={runningAnalysis}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 13, fontWeight: 600, cursor: runningAnalysis ? 'not-allowed' : 'pointer', opacity: runningAnalysis ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            {runningAnalysis ? <><Loader2 size={14} className="animate-spin" /> Running…</> : 'Analyse Outfits'}
          </button>
        </div>
      </div>
    )
  }

  if (analysisRan && misclassifications.length === 0) {
    return (
      <div style={{ paddingTop: 64, textAlign: 'center' }}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>No suspicious classifications found.</p>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <ThresholdSliders
            similarityThreshold={similarityThreshold}
            setSimilarityThreshold={setSimilarityThreshold}
            margin={margin}
            setMargin={setMargin}
          />
          <button
            onClick={onRunAnalysis}
            disabled={runningAnalysis}
            style={{ fontSize: 13, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {runningAnalysis ? 'Running…' : 'Re-run analysis'}
          </button>
        </div>
      </div>
    )
  }

  const pm = misclassifications[queueIdx]
  if (!pm) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#a1a1aa' }}>Flag {queueIdx + 1} of {misclassifications.length}</span>
        {queueIdx < misclassifications.length - 1 && (
          <button onClick={() => setQueueIdx(i => i + 1)} style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>
            Skip →
          </button>
        )}
      </div>

      {/* Face crop */}
      {pm.face_crop ? (
        <img
          src={`data:image/jpeg;base64,${pm.face_crop}`}
          alt="Face"
          style={{ width: 230, height: 230, borderRadius: 14, objectFit: 'cover', border: '1px solid var(--border)' }}
        />
      ) : (
        <div style={{ width: 230, height: 230, borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <UserX size={40} style={{ color: 'var(--text-muted)' }} />
        </div>
      )}
      <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', color: '#71717A', marginTop: 10 }}>
        {pm.photo_name ?? '—'}
      </div>
      {pm.outfit_correlation && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#a1a1aa' }}>
          Outfit match: {Math.round(pm.outfit_correlation * 100)}%
        </div>
      )}

      <div style={{ width: '100%', maxWidth: 560, marginTop: 22 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 18, textAlign: 'center' }}>
          Is this <span style={{ color: 'var(--accent)' }}>{pm.current_person_name}</span> or <span style={{ color: '#f59e0b' }}>{pm.outfit_suggests_name}</span>?
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={() => onKeep(pm.id)}
            disabled={acting}
            style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: acting ? 0.7 : 1 }}
          >
            {acting ? '…' : `Keep as ${pm.current_person_name}`}
          </button>
          <button
            onClick={() => onReassign(pm.id)}
            disabled={acting}
            style={{ background: '#f59e0b', color: '#000', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: acting ? 0.7 : 1 }}
          >
            {acting ? '…' : `Reassign to ${pm.outfit_suggests_name}`}
          </button>
        </div>
      </div>

      {misclassifications.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 24 }}>
          <button
            onClick={() => setQueueIdx(i => Math.max(0, i - 1))}
            disabled={queueIdx === 0}
            style={{ fontSize: 13, fontWeight: 600, color: '#71717A', background: 'none', border: 'none', cursor: queueIdx === 0 ? 'not-allowed' : 'pointer', opacity: queueIdx === 0 ? 0.3 : 1 }}
          >
            ← Prev
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            {misclassifications.slice(0, Math.min(8, misclassifications.length)).map((_, i) => (
              <button
                key={i}
                onClick={() => setQueueIdx(() => i)}
                style={{ width: 7, height: 7, borderRadius: '50%', background: i === queueIdx ? 'var(--accent)' : 'var(--border)', border: 'none', cursor: 'pointer', padding: 0 }}
              />
            ))}
            {misclassifications.length > 8 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>…</span>}
          </div>
          <button
            onClick={() => setQueueIdx(i => Math.min(misclassifications.length - 1, i + 1))}
            disabled={queueIdx === misclassifications.length - 1}
            style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: queueIdx === misclassifications.length - 1 ? 'not-allowed' : 'pointer', opacity: queueIdx === misclassifications.length - 1 ? 0.3 : 1 }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

// ── Tab button ─────────────────────────────────────────────────────────────────

function TabButton({ label, count, active, onClick, disabled }: {
  label: string; count: number; active: boolean; onClick: () => void; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        background: active ? '#7C6EF8' : 'transparent',
        color: active ? '#fff' : '#52525b',
        border: active ? 'none' : '1px solid var(--border)',
        borderRadius: 9, padding: '9px 14px',
        fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !active ? 0.5 : 1,
      }}
    >
      {label}
      <span
        style={{
          background: active ? 'rgba(255,255,255,.25)' : 'var(--surface)',
          borderRadius: 20, padding: '1px 7px',
          fontSize: 11, fontWeight: 700,
          color: active ? '#fff' : 'var(--text-muted)',
        }}
      >
        {count}
      </span>
    </button>
  )
}

// ── Misc cluster list ───────────────────────────────────────────────────────────

function MiscClusterList({
  clusters, totalFaces, persons, clusterActing,
  onAssign, onCreate, onDismiss, onDismissAllSingletons,
}: {
  clusters: MiscCluster[]
  totalFaces: number
  persons: { name: string; person_id: string; photo_count: number }[]
  clusterActing: Set<number>
  onAssign: (clusterId: number, faceIds: string[], personId: string) => void
  onCreate: (clusterId: number, faceIds: string[], name: string) => void
  onDismiss: (clusterId: number, faceIds: string[]) => void
  onDismissAllSingletons: () => void
}) {
  if (totalFaces === 0) {
    return (
      <div style={{ paddingTop: 64, textAlign: 'center' }}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>All faces were assigned or dismissed.</p>
      </div>
    )
  }

  const repeated   = clusters.filter(c => c.size >= 2)
  const singletons = clusters.filter(c => c.size === 1)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 18 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>
          {clusters.length} cluster{clusters.length !== 1 ? 's' : ''} · {totalFaces} faces
        </span>
      </div>

      {repeated.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#71717A', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
            Repeated appearances
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {repeated.map(c => (
              <MiscClusterRow
                key={c.cluster_id}
                cluster={c}
                persons={persons}
                acting={clusterActing.has(c.cluster_id)}
                onAssign={(pid) => onAssign(c.cluster_id, c.face_ids, pid)}
                onCreate={(name) => onCreate(c.cluster_id, c.face_ids, name)}
                onDismiss={() => onDismiss(c.cluster_id, c.face_ids)}
              />
            ))}
          </div>
        </div>
      )}

      {singletons.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#71717A', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              One-off appearances
            </span>
            <button
              onClick={onDismissAllSingletons}
              style={{ fontSize: 12, fontWeight: 600, color: '#a1a1aa', background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px', cursor: 'pointer' }}
            >
              Dismiss all strangers ({singletons.length})
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 10 }}>
            {singletons.map(c => (
              <MiscSingletonCard
                key={c.cluster_id}
                cluster={c}
                persons={persons}
                acting={clusterActing.has(c.cluster_id)}
                onAssign={(pid) => onAssign(c.cluster_id, c.face_ids, pid)}
                onCreate={(name) => onCreate(c.cluster_id, c.face_ids, name)}
                onDismiss={() => onDismiss(c.cluster_id, c.face_ids)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function MiscClusterRow({ cluster, persons, acting, onAssign, onCreate, onDismiss }: {
  cluster: MiscCluster
  persons: { name: string; person_id: string; photo_count: number }[]
  acting: boolean
  onAssign: (personId: string) => void
  onCreate: (name: string) => void
  onDismiss: () => void
}) {
  const [mode, setMode] = useState<'idle' | 'pick' | 'new'>('idle')
  const [pickedId, setPickedId] = useState('')
  const [newName, setNewName] = useState('')

  function reset() { setMode('idle'); setPickedId(''); setNewName('') }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px' }}>
      {/* Top row: crops + count + action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* Overlapping crops */}
        <div style={{ display: 'flex', flexShrink: 0 }}>
          {cluster.representative_crops.slice(0, 3).map((crop, i) => (
            <img
              key={i}
              src={`data:image/jpeg;base64,${crop}`}
              style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover', border: '2px solid var(--surface)', marginLeft: i > 0 ? -12 : 0 }}
              alt=""
            />
          ))}
        </div>

        <span style={{ fontSize: 12, fontWeight: 500, color: '#71717A', width: 90, flexShrink: 0 }}>
          {cluster.size} appearances
        </span>

        <div style={{ flex: 1 }} />

        {mode === 'idle' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setMode('pick')}
              disabled={acting}
              style={{ fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', opacity: acting ? 0.5 : 1 }}
            >
              {acting ? <Loader2 size={12} className="animate-spin" /> : 'Assign…'}
            </button>
            <button
              onClick={onDismiss}
              disabled={acting}
              style={{ fontSize: 12, fontWeight: 600, background: 'transparent', color: '#71717A', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 10px', cursor: 'pointer', opacity: acting ? 0.5 : 1 }}
            >
              Dismiss all
            </button>
          </div>
        )}
      </div>

      {/* Expanded: person picker */}
      {mode === 'pick' && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
            {persons.map(p => {
              const isSel = p.person_id === pickedId
              return (
                <button
                  key={p.person_id}
                  onClick={() => setPickedId(isSel ? '' : p.person_id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    background: isSel ? 'rgba(124,110,248,.16)' : 'var(--bg)',
                    border: `1px solid ${isSel ? '#7C6EF8' : 'var(--border)'}`,
                    borderRadius: 30, padding: '4px 12px 4px 4px', cursor: 'pointer',
                  }}
                >
                  <img src={`/api/persons/${p.person_id}/thumbnail`} alt={p.name}
                    style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', background: 'var(--border)' }}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</span>
                </button>
              )
            })}
            <button
              onClick={() => { setMode('new'); setPickedId('') }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px dashed #3f3f46', borderRadius: 30, padding: '6px 12px', background: 'transparent', color: '#a1a1aa', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              + New person
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {pickedId && (
              <button
                onClick={() => { onAssign(pickedId); reset() }}
                disabled={acting}
                style={{ fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', opacity: acting ? 0.5 : 1 }}
              >
                {acting ? '…' : `Confirm → ${persons.find(p => p.person_id === pickedId)?.name ?? ''}`}
              </button>
            )}
            <button onClick={reset} style={{ fontSize: 12, color: '#71717A', background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 12px', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Expanded: new person input */}
      {mode === 'new' && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { onCreate(newName.trim()); reset() } }}
            placeholder="New person name…"
            style={{ flex: 1, height: 34, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text-primary)', padding: '0 10px', fontSize: 12, outline: 'none' }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
          <button
            onClick={() => { if (newName.trim()) { onCreate(newName.trim()); reset() } }}
            disabled={!newName.trim() || acting}
            style={{ fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '0 14px', cursor: 'pointer', opacity: !newName.trim() || acting ? 0.5 : 1 }}
          >
            Create
          </button>
          <button onClick={reset} style={{ fontSize: 12, color: '#71717A', background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, padding: '0 12px', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

function MiscSingletonCard({ cluster, persons, acting, onAssign, onCreate, onDismiss }: {
  cluster: MiscCluster
  persons: { name: string; person_id: string; photo_count: number }[]
  acting: boolean
  onAssign: (personId: string) => void
  onCreate: (name: string) => void
  onDismiss: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [pickedId, setPickedId] = useState('')
  const [newName, setNewName] = useState('')
  const [mode, setMode] = useState<'pick' | 'new'>('pick')

  const crop = cluster.representative_crops[0]

  if (!expanded) {
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 8, textAlign: 'center' }}>
        {crop ? (
          <img src={`data:image/jpeg;base64,${crop}`} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 7, marginBottom: 6, display: 'block' }} alt="" />
        ) : (
          <div style={{ width: '100%', aspectRatio: '1', background: 'var(--surface-2)', borderRadius: 7, marginBottom: 6 }} />
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => setExpanded(true)}
            style={{ flex: 1, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 5, padding: '5px 0', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
          >
            Assign
          </button>
          <button
            onClick={onDismiss}
            disabled={acting}
            style={{ width: 26, background: 'var(--bg)', color: '#71717A', border: '1px solid var(--border)', borderRadius: 5, fontSize: 12, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ gridColumn: '1 / -1', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        {crop && <img src={`data:image/jpeg;base64,${crop}`} style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }} alt="" />}
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setMode('pick')} style={{ fontSize: 11, fontWeight: 600, background: mode === 'pick' ? 'rgba(124,110,248,.15)' : 'transparent', color: mode === 'pick' ? 'var(--accent)' : '#71717A', border: `1px solid ${mode === 'pick' ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
            Assign to…
          </button>
          <button onClick={() => setMode('new')} style={{ fontSize: 11, fontWeight: 600, background: mode === 'new' ? 'rgba(124,110,248,.15)' : 'transparent', color: mode === 'new' ? 'var(--accent)' : '#71717A', border: `1px solid ${mode === 'new' ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
            New person
          </button>
          <button onClick={() => { setExpanded(false); setPickedId('') }} style={{ fontSize: 11, color: '#71717A', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
      {mode === 'pick' ? (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {persons.map(p => {
              const isSel = p.person_id === pickedId
              return (
                <button key={p.person_id} onClick={() => setPickedId(isSel ? '' : p.person_id)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: isSel ? 'rgba(124,110,248,.16)' : 'var(--bg)', border: `1px solid ${isSel ? '#7C6EF8' : 'var(--border)'}`, borderRadius: 20, padding: '3px 10px 3px 3px', cursor: 'pointer' }}
                >
                  <img src={`/api/persons/${p.person_id}/thumbnail`} alt={p.name} style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</span>
                </button>
              )
            })}
          </div>
          {pickedId && (
            <button onClick={() => { onAssign(pickedId); setExpanded(false); setPickedId('') }} disabled={acting}
              style={{ fontSize: 11, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', opacity: acting ? 0.5 : 1 }}>
              {acting ? '…' : `Confirm → ${persons.find(p => p.person_id === pickedId)?.name ?? ''}`}
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6 }}>
          <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { onCreate(newName.trim()); setExpanded(false) } }}
            placeholder="Name…"
            style={{ flex: 1, height: 30, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text-primary)', padding: '0 8px', fontSize: 11, outline: 'none' }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
          <button onClick={() => { if (newName.trim()) { onCreate(newName.trim()); setExpanded(false) } }} disabled={!newName.trim() || acting}
            style={{ fontSize: 11, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '0 12px', cursor: 'pointer', opacity: !newName.trim() || acting ? 0.5 : 1 }}>
            Create
          </button>
        </div>
      )}
    </div>
  )
}
