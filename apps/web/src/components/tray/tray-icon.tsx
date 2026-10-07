/** A tray glyph (the board's `a2-tray` symbol), kept apart so the header chip stays light. */
export function TrayIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M3 13h5l1.5 3h5L16 13h5M5.5 6h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z" />
    </svg>
  );
}
