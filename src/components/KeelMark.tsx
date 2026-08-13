/**
 * The Keel mark - the favicon's sailboat as an inline component, so the app
 * wears the same face in the UI as in the browser tab. Same artwork as
 * src/app/icon.svg; if one changes, change both.
 */
export default function KeelMark({
  size = 20,
  className = "",
}: {
  /** Rendered width/height in px. The artwork stays legible down to 16. */
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`inline-block shrink-0 align-[-0.2em] ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="#16233d" />
      <path d="M31 7 L31 30 L12 30 Z" fill="#f2ede2" />
      <path d="M36 12 L36 30 L52 30 Z" fill="#f2ede2" />
      <path d="M9 34 L55 34 C 51 41, 44 44, 33 44 C 23 44, 14 40, 9 34 Z" fill="#f2ede2" />
      <path d="M25 43 L33 43 L28 57 L21 57 Z" fill="#f2ede2" />
      <rect x="4" y="31.5" width="56" height="4" rx="2" fill="#5a8bd6" />
    </svg>
  );
}
