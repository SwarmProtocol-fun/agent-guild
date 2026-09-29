"use client";
/** Stub — ReactBits GradientText extracted to mod. Plain text fallback. */
export default function GradientText({ children, className }: { children: React.ReactNode; className?: string; colors?: string[]; animationSpeed?: number; [k: string]: unknown }) {
  return <span className={className}>{children}</span>;
}
