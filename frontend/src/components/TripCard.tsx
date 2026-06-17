import { useNavigate } from 'react-router-dom'
import { Images, Users, Calendar, ChevronRight } from 'lucide-react'
import type { Trip } from '../api/client'

const STATUS_STYLES: Record<string, string> = {
  created:           'bg-zinc-800 text-zinc-400',
  ingesting:         'bg-blue-950 text-blue-400 animate-pulse',
  ingested:          'bg-emerald-950 text-emerald-400',
  extracting_faces:  'bg-blue-950 text-blue-400 animate-pulse',
  faces_extracted:   'bg-emerald-950 text-emerald-400',
  enrolled:          'bg-violet-950 text-violet-400',
  classified:        'bg-amber-950 text-amber-400',
  uploaded:          'bg-green-950 text-green-400',
  failed:            'bg-red-950 text-red-400',
}

const STATUS_LABELS: Record<string, string> = {
  created:           'Ready to ingest',
  ingesting:         'Ingesting…',
  ingested:          'Ingested',
  extracting_faces:  'Extracting faces…',
  faces_extracted:   'Faces extracted',
  enrolled:          'Enrolled',
  classified:        'Classified',
  uploaded:          'Done',
  failed:            'Failed',
}

interface Props {
  trip: Trip
}

export function TripCard({ trip }: Props) {
  const navigate = useNavigate()
  const statusStyle = STATUS_STYLES[trip.status] ?? STATUS_STYLES.created
  const statusLabel = STATUS_LABELS[trip.status] ?? trip.status

  return (
    <button
      onClick={() => navigate(`/trips/${trip.id}`)}
      className="w-full text-left bg-zinc-900 hover:bg-zinc-800/80 border border-zinc-800 hover:border-zinc-700 rounded-xl p-5 transition-all group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-3">
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${statusStyle}`}>
              {statusLabel}
            </span>
          </div>
          <h3 className="text-white font-semibold text-base truncate mb-3">{trip.name}</h3>
          <div className="flex items-center gap-4 text-zinc-500 text-sm">
            <span className="flex items-center gap-1.5">
              <Images size={14} />
              {trip.photo_count} photos
            </span>
            {trip.expected_member_count && (
              <span className="flex items-center gap-1.5">
                <Users size={14} />
                {trip.expected_member_count} people
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Calendar size={14} />
              {new Date(trip.created_at).toLocaleDateString()}
            </span>
          </div>
        </div>
        <ChevronRight size={18} className="text-zinc-600 group-hover:text-zinc-400 mt-1 transition-colors shrink-0" />
      </div>
    </button>
  )
}
