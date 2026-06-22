import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Trip } from '../api/client'
import { StatusPill } from './StatusPill'

const PROCESSING_STATUSES = new Set([
  'ingesting', 'extracting_faces', 'classified', 'body_detecting',
])

interface Props {
  trip: Trip
}

export function TripCard({ trip }: Props) {
  const navigate = useNavigate()
  const [coverLoaded, setCoverLoaded] = useState(false)
  const [coverError, setCoverError] = useState(false)

  const isProcessing = PROCESSING_STATUSES.has(trip.status)
  const isFailed = trip.status === 'failed'

  return (
    <button
      onClick={() => navigate(`/trips/${trip.id}`)}
      className="relative w-full text-left overflow-hidden group"
      style={{
        height: 288,
        borderRadius: 12,
        border: '1px solid var(--border)',
        background: '#0f0f1a',
        display: 'block',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = '#3f3f52')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      {/* Placeholder gradient */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(135deg, #12122a 0%, #1a1535 50%, #0f0f1e 100%)',
          opacity: coverLoaded ? 0 : 1,
          transition: 'opacity 0.3s',
        }}
      />

      {/* Cover photo */}
      {!coverError && (
        <img
          src={`/api/trips/${trip.id}/cover`}
          onLoad={() => setCoverLoaded(true)}
          onError={() => setCoverError(true)}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: coverLoaded ? 1 : 0, transition: 'opacity 0.3s' }}
          alt=""
        />
      )}

      {/* Bottom gradient */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'linear-gradient(to top, rgba(8,8,11,.92) 0%, rgba(8,8,11,.55) 40%, rgba(8,8,11,.1) 80%, transparent 100%)' }}
      />

      {/* Processing dim overlay */}
      {isProcessing && (
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'rgba(8,8,11,.4)' }} />
      )}

      {/* Failed badge — solid red, top-right */}
      {isFailed && (
        <div
          className="absolute"
          style={{
            top: 12, right: 12,
            background: '#EF4444', color: '#fff',
            fontWeight: 700, fontSize: 10,
            padding: '4px 8px', borderRadius: 6,
          }}
        >
          ⚠ FAILED
        </div>
      )}

      {/* Bottom text overlay */}
      <div className="absolute bottom-0 left-0 right-0" style={{ padding: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 19, color: '#F4F4F5', lineHeight: 1.2, marginBottom: 8 }}>
          {trip.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: '#a1a1aa' }}>
            {trip.photo_count > 0 ? `${trip.photo_count} photos` : 'No photos yet'}
            {trip.expected_member_count ? ` · ${trip.expected_member_count} people` : ''}
          </span>
          <StatusPill status={trip.status} />
        </div>
      </div>

      {/* Indeterminate progress bar — 3px at bottom edge */}
      {isProcessing && (
        <div className="absolute bottom-0 left-0 right-0 overflow-hidden" style={{ height: 3, background: 'rgba(124,110,248,.25)' }}>
          <div
            className="absolute inset-y-0 progress-indeterminate"
            style={{ width: '35%', background: '#7C6EF8' }}
          />
        </div>
      )}
    </button>
  )
}
