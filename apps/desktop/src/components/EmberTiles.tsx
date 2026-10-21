/** Decorative ember-tile brand art for welcome, onboarding and empty states.
   A 4x3 grid of frosted tiles over an accent glow with the luminous link
   shape overlapping the right side — purely decorative, always hidden. */
export function EmberTiles({ className }: { className?: string }) {
  return (
    <div className={`ember-tiles${className ? ` ${className}` : ""}`} aria-hidden="true">
      <div className="ember-tiles-glow" />
      <div className="ember-tiles-grid">
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <svg className="ember-tiles-link" viewBox="0 0 160 160" aria-hidden="true">
        <defs>
          {/* Meld the blocks into one molded shape: blur, then threshold alpha. */}
          <filter id="ember-link-goo" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" />
          </filter>
        </defs>
        {/* Z-tetromino link: a 2u bar up top, a 2u bar shifted right below;
            the 1u overlap goos into a concave fillet. u = 48, viewBox 160. */}
        <g filter="url(#ember-link-goo)">
          <rect x="8" y="32" width="96" height="48" rx="20" fill="#FFFFFF" />
          <rect x="56" y="80" width="96" height="48" rx="20" fill="#FFFFFF" />
        </g>
      </svg>
    </div>
  );
}
