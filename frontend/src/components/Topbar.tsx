import { useNavigate, Link } from 'react-router-dom'
import { Plus, ChevronLeft } from 'lucide-react'

export interface BreadcrumbItem {
  label: string
  href?: string
}

interface TopbarProps {
  breadcrumbs?: BreadcrumbItem[]
  actions?: React.ReactNode
  backHref?: string
}

export function Topbar({ breadcrumbs = [], actions, backHref }: TopbarProps) {
  const navigate = useNavigate()

  return (
    <header
      style={{
        position: 'sticky', top: 0, zIndex: 40,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 56, padding: '0 22px',
        background: 'var(--bg)', borderBottom: '1px solid var(--border)',
      }}
    >
      <nav style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0 }}>
        {backHref && (
          <button
            onClick={() => navigate(backHref)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, borderRadius: 7,
              background: 'var(--surface)', border: '1px solid var(--border)',
              color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <button
          onClick={() => navigate('/')}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <HexIcon />
          <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Focal</span>
        </button>

        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1
          return (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ color: '#3f3f46' }}>/</span>
              {crumb.href ? (
                <Link
                  to={crumb.href}
                  style={{ color: '#a1a1aa', fontWeight: 500, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  style={{
                    color: isLast ? 'var(--text-primary)' : '#a1a1aa',
                    fontWeight: isLast ? 600 : 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {crumb.label}
                </span>
              )}
            </span>
          )
        })}
      </nav>

      {actions && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 16 }}>
          {actions}
        </div>
      )}
    </header>
  )
}

export function NewTripButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'var(--accent)', color: '#fff', border: 'none',
        borderRadius: 7, padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
    >
      <Plus size={14} />
      New Trip
    </button>
  )
}

function HexIcon() {
  return (
    <div
      style={{
        width: 18,
        height: 20,
        background: 'var(--accent)',
        clipPath: 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)',
        flexShrink: 0,
      }}
    />
  )
}
