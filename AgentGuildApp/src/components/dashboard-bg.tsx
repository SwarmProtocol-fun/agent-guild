/** Dashboard Background — Animated dark gradient background with subtle particle effects. */
"use client";

import dynamic from "next/dynamic";

const Squares = dynamic(() => import("@/components/reactbits/Squares"), { ssr: false });

export function DashboardBackground() {
  return (
    <>
      <div className="fixed inset-0 z-0 opacity-20 pointer-events-none">
        <Squares
          direction="diagonal"
          speed={0.3}
          borderColor="rgba(255, 215, 0, 0.06)"
          squareSize={50}
          hoverFillColor="rgba(255, 215, 0, 0.03)"
        />
      </div>
      <div className="scan-line-overlay" />
    </>
  );
}
