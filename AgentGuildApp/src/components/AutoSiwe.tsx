/**
 * AutoSiwe — Global invisible component that auto-triggers SIWE login.
 *
 * Mounted in layout.tsx inside Web3Provider + SessionProvider.
 * Renders nothing — just runs the useAutoSiwe hook so that
 * wallet connections (including OAuth redirect reconnections)
 * automatically trigger SIWE signing and session creation.
 */
"use client";

import { useAutoSiwe } from "@/hooks/useAutoSiwe";

export default function AutoSiwe() {
  useAutoSiwe();
  return null;
}
