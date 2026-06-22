interface Config {
  dotColor: string
  textColor: string
  bg: string
  label: string
  pulse?: boolean
}

const CONFIGS: Record<string, Config> = {
  created:           { dotColor: '#71717A', textColor: '#a1a1aa',  bg: 'rgba(113,113,122,.15)', label: 'Created' },
  ingesting:         { dotColor: '#7C6EF8', textColor: '#c4b5fd',  bg: 'rgba(124,110,248,.18)', label: 'Ingesting',        pulse: true },
  ingested:          { dotColor: '#22C55E', textColor: '#86efac',  bg: 'rgba(34,197,94,.16)',   label: 'Ingested' },
  extracting_faces:  { dotColor: '#7C6EF8', textColor: '#c4b5fd',  bg: 'rgba(124,110,248,.18)', label: 'Extracting Faces', pulse: true },
  faces_extracted:   { dotColor: '#22C55E', textColor: '#86efac',  bg: 'rgba(34,197,94,.16)',   label: 'Faces Extracted' },
  enrolled:          { dotColor: '#7C6EF8', textColor: '#c4b5fd',  bg: 'rgba(124,110,248,.18)', label: 'Ready to Classify' },
  classified:        { dotColor: '#7C6EF8', textColor: '#c4b5fd',  bg: 'rgba(124,110,248,.18)', label: 'Classified',       pulse: true },
  uploaded:          { dotColor: '#22C55E', textColor: '#86efac',  bg: 'rgba(34,197,94,.16)',   label: 'Uploaded' },
  body_detecting:    { dotColor: '#7C6EF8', textColor: '#c4b5fd',  bg: 'rgba(124,110,248,.18)', label: 'Body Detecting',   pulse: true },
  body_detected:     { dotColor: '#22C55E', textColor: '#86efac',  bg: 'rgba(34,197,94,.16)',   label: 'Body Detected' },
  failed:            { dotColor: '#EF4444', textColor: '#fca5a5',  bg: 'rgba(239,68,68,.16)',   label: 'Failed' },
}

interface Props {
  status: string
  label?: string
}

export function StatusPill({ status, label }: Props) {
  const cfg = CONFIGS[status] ?? { dotColor: '#71717A', textColor: '#a1a1aa', bg: 'rgba(113,113,122,.15)', label: status }
  const displayLabel = label ?? cfg.label

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        color: cfg.textColor,
        background: cfg.bg,
        padding: '3px 9px',
        borderRadius: 20,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: cfg.dotColor,
          display: 'inline-block',
          flexShrink: 0,
          animation: cfg.pulse ? 'wpulse 1.4s ease-in-out infinite' : undefined,
        }}
      />
      {displayLabel}
    </span>
  )
}
