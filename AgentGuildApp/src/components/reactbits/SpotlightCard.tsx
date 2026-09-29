"use client";
/** Stub — ReactBits SpotlightCard extracted to mod. Plain card fallback. */
export default function SpotlightCard({ children, className, ...props }: { children: React.ReactNode; className?: string; spotlightColor?: string; [k: string]: unknown }) {
  return <div className={className} {...props}>{children}</div>;
}
