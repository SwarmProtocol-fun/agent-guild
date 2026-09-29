"use client";
/** Stub — ReactBits CountUp extracted to mod. Static number fallback. */
export default function CountUp({ to, className }: { from?: number; to: number; className?: string; duration?: number; [k: string]: unknown }) {
  return <span className={className}>{to}</span>;
}
