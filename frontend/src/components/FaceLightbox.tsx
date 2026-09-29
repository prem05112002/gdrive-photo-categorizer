import { useState } from 'react'
import { Loader2, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { api, type FaceRep } from '../api/client'
import { countLabel } from '../lib/faces'

// ── Face in context ────────────────────────────────────────────────────────────
//
// Shows one of a cluster's sample faces cropped from the original photo with
// its surroundings (the backend outlines the face), plus a strip to flip
// through the other samples. Used by Enroll (name the person) and Review
// (assign to a person) — the page supplies the action row as children.

export interface FaceLightboxCluster {
  size: number
  photo_count: number
  representatives: FaceRep[]
}

export function FaceLightbox({ cluster, index, title, onIndex, onClose, children }: {
  cluster: FaceLightboxCluster
  index: number
  title: string
  onIndex: (i: number) => void
  onClose: () => void
  children?: React.ReactNode
}) {
  const reps = cluster.representatives
  const rep = reps[index]
  const [loadedId, setLoadedId] = useState<string | null>(null)   // face whose context image has arrived

  if (!rep) return null
  const loaded = loadedId === rep.face_id

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(8,8,11,.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ width: 'min(860px, 96vw)', maxHeight: '94vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <button onClick={onClose} style={closeBtn}><X size={16} /></button>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {title} · {countLabel(cluster)}
          </span>
          <span style={{ marginLeft: 'auto', minWidth: 0, fontSize: 12, fontFamily: 'ui-monospace, monospace', color: '#71717A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {rep.file_name}
          </span>
          <span style={{ fontSize: 12, color: '#71717A', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
            {index + 1} / {reps.length}
          </span>
        </div>

        <div style={{ position: 'relative', height: 'min(62vh, 560px)', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {!loaded && (
            <Loader2 className="animate-spin" size={22} style={{ position: 'absolute', color: 'var(--accent)' }} />
          )}
          <img
            key={rep.face_id}
            src={api.photos.faceContextUrl(rep.photo_id, rep.face_id, 800)}
            onLoad={() => setLoadedId(rep.face_id)}
            alt=""
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', opacity: loaded ? 1 : 0, transition: 'opacity .15s' }}
          />
          {reps.length > 1 && (
            <>
              <button onClick={() => onIndex(Math.max(0, index - 1))} disabled={index === 0} style={{ ...arrowBtn, left: 10, opacity: index === 0 ? 0.25 : 1 }}>
                <ChevronLeft size={18} />
              </button>
              <button onClick={() => onIndex(Math.min(reps.length - 1, index + 1))} disabled={index === reps.length - 1} style={{ ...arrowBtn, right: 10, opacity: index === reps.length - 1 ? 0.25 : 1 }}>
                <ChevronRight size={18} />
              </button>
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {reps.map((r, i) => (
              <img
                key={r.face_id}
                src={`data:image/jpeg;base64,${r.crop}`}
                onClick={() => onIndex(i)}
                alt=""
                style={{
                  width: 48, height: 48, borderRadius: 8, objectFit: 'cover', cursor: 'pointer',
                  outline: i === index ? '2px solid var(--accent)' : '2px solid transparent', outlineOffset: 1,
                  opacity: i === index ? 1 : 0.7,
                }}
              />
            ))}
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

const closeBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 7, padding: '6px 10px',
  color: '#a1a1aa', cursor: 'pointer', display: 'flex', alignItems: 'center',
}

const arrowBtn: React.CSSProperties = {
  position: 'absolute', top: '50%', transform: 'translateY(-50%)',
  width: 36, height: 36, borderRadius: '50%', border: 'none',
  background: 'rgba(22,22,31,.85)', color: 'var(--text-primary)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
}
