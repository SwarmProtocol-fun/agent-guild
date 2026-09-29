/**
 * PostHog client — browser-side init and event capture.
 *
 * Captures pageviews (manual, app-router) + autocapture (clicks/inputs) +
 * custom marketplace/compute events. Server-side reads for the admin
 * dashboard live in src/app/api/admin/analytics/{events,pages}/route.ts —
 * those query the PostHog API directly and don't need this module.
 *
 * No-ops entirely if NEXT_PUBLIC_POSTHOG_KEY is unset, so local/dev
 * environments without a PostHog project keep working unchanged.
 */
"use client";

import posthog from "posthog-js";

let initialized = false;

/** Idempotent — safe to call from multiple components on every render. */
export function initPostHog(): void {
  if (initialized || typeof window === "undefined") return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    // App router navigations don't trigger a full page load, so we capture
    // $pageview manually on route change (see PostHogPageview below)
    // rather than relying on posthog-js's own load-time capture.
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: true,
    // Track anonymous visitors too (landing page, docs) — not just wallets
    // that complete SIWE login — so "how many users" reflects real traffic.
    person_profiles: "always",
  });
  initialized = true;
}

export function isPostHogEnabled(): boolean {
  return initialized;
}

/** Associate all prior + future anonymous activity with a wallet address. */
export function identifyWallet(walletAddress: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.identify(walletAddress.toLowerCase(), properties);
}

/** Clear identity on logout so the next visitor isn't attributed to the last wallet. */
export function resetIdentity(): void {
  if (!initialized) return;
  posthog.reset();
}

/** Manual pageview capture for client-side route changes (app router). */
export function capturePageview(url: string): void {
  if (!initialized) return;
  posthog.capture("$pageview", { $current_url: url });
}

/** Fire a custom event. No-ops if PostHog isn't configured. */
export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(name, properties);
}
