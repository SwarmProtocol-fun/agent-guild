/**
 * Vitest global setup
 * Runs before all tests
 */

import { expect, afterEach } from 'vitest';

// lib/firebase.ts initializes the client SDK at import time and getAuth() throws
// without an API key. Vitest doesn't load .env.local, and tests must not depend
// on real credentials, so provide inert placeholders.
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ??= 'test-api-key';
process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??= 'test.firebaseapp.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= 'test-project';
process.env.NEXT_PUBLIC_FIREBASE_APP_ID ??= 'test-app-id';

import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// Cleanup after each test case
afterEach(() => {
  cleanup();
});

// Extend Vitest matchers with jest-dom assertions
expect.extend({});
