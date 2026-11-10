import { useId } from 'react';

/** 品牌图标: 与 favicon.svg 同一套几何, 内联渲染以便在深浅色下都清晰。 */
export function BrandMark({ size = 30 }: { size?: number }) {
  const raw = useId();
  const uid = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  const bgId = `hh-bg-${uid}`;
  const inkId = `hh-ink-${uid}`;
  const glowId = `hh-glow-${uid}`;

  return (
    <svg
      className="brand-svg"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label="Harness Hub"
    >
      <defs>
        <linearGradient id={bgId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#20253c" />
          <stop offset="0.5" stopColor="#131727" />
          <stop offset="1" stopColor="#0a0c14" />
        </linearGradient>
        <linearGradient id={inkId} x1="0.08" y1="0.02" x2="0.92" y2="0.98">
          <stop offset="0" stopColor="#b6a9ff" />
          <stop offset="0.52" stopColor="#8b7bff" />
          <stop offset="1" stopColor="#4fd1c5" />
        </linearGradient>
        <radialGradient id={glowId} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#8b7bff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#8b7bff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="16" y="16" width="480" height="480" rx="112" fill={`url(#${bgId})`} />
      <rect
        x="17.5"
        y="17.5"
        width="477"
        height="477"
        rx="110.5"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.1"
        strokeWidth="3"
      />
      <circle cx="256" cy="256" r="154" fill="none" stroke={`url(#${inkId})`} strokeOpacity="0.16" strokeWidth="2.5" />
      <circle cx="256" cy="256" r="104" fill={`url(#${glowId})`} />
      <g fill={`url(#${inkId})`}>
        <rect x="152" y="136" width="54" height="240" rx="27" />
        <rect x="306" y="136" width="54" height="240" rx="27" />
        <rect x="179" y="229" width="154" height="54" rx="27" />
      </g>
      <circle cx="256" cy="256" r="21" fill="#0b0e18" fillOpacity="0.92" />
      <circle cx="256" cy="256" r="10" fill="#7ff0e2" />
    </svg>
  );
}
