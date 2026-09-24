"use client";
/** Stub — ReactBits ShinyText extracted to mod. Plain text fallback. */
export default function ShinyText({ children, text, className }: { children?: React.ReactNode; text?: string; className?: string; speed?: number; [k: string]: unknown }) {
  // The real component takes `text=`; callers use either that or children.
  return <span className={className}>{children ?? text}</span>;
}
