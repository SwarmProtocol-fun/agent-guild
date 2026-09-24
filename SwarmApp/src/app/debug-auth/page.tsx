"use client";

import { useSession } from "@/contexts/SessionContext";
import { useWalletAccount } from "@/lib/wallet";
import { useEffect, useState } from "react";

export default function DebugAuthPage() {
  const session = useSession();
  const account = useWalletAccount();
  const [sessionCheck, setSessionCheck] = useState<any>(null);
  const [cookieCheck, setCookieCheck] = useState<string>("checking...");

  // Fetch session status
  useEffect(() => {
    fetch("/api/auth/session", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        console.log("[Debug] Session API response:", data);
        setSessionCheck(data);
      })
      .catch((err) => {
        console.error("[Debug] Session API error:", err);
        setSessionCheck({ error: err.message });
      });

    // Check if cookie exists (client-side check)
    const cookies = document.cookie;
    console.log("[Debug] All cookies:", cookies);
    setCookieCheck(cookies || "No cookies found");
  }, []);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">🔍 Authentication Debug</h1>

      <div className="space-y-6">
        {/* SessionContext State */}
        <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
          <h2 className="text-xl font-semibold mb-4 text-amber-500">
            SessionContext State
          </h2>
          <pre className="bg-black p-4 rounded text-sm overflow-auto">
            {JSON.stringify(
              {
                authenticated: session.authenticated,
                loading: session.loading,
                address: session.address,
                role: session.role,
                sessionId: session.sessionId,
              },
              null,
              2
            )}
          </pre>
        </div>

        {/* Active Wallet */}
        <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
          <h2 className="text-xl font-semibold mb-4 text-amber-500">
            Active Wallet (Thirdweb)
          </h2>
          <pre className="bg-black p-4 rounded text-sm overflow-auto">
            {JSON.stringify(
              {
                connected: !!account,
                address: account?.address || null,
              },
              null,
              2
            )}
          </pre>
        </div>

        {/* Session API Check */}
        <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
          <h2 className="text-xl font-semibold mb-4 text-amber-500">
            /api/auth/session Response
          </h2>
          <pre className="bg-black p-4 rounded text-sm overflow-auto">
            {sessionCheck ? JSON.stringify(sessionCheck, null, 2) : "Loading..."}
          </pre>
        </div>

        {/* Cookie Check */}
        <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
          <h2 className="text-xl font-semibold mb-4 text-amber-500">
            Browser Cookies
          </h2>
          <pre className="bg-black p-4 rounded text-sm overflow-auto whitespace-pre-wrap break-all">
            {cookieCheck}
          </pre>
          <p className="text-sm text-gray-400 mt-2">
            Note: httpOnly cookies won't be visible here (that's correct!)
          </p>
        </div>

        {/* Manual Session Refresh */}
        <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
          <h2 className="text-xl font-semibold mb-4 text-amber-500">Actions</h2>
          <div className="space-y-2">
            <button
              onClick={() => {
                console.log("[Debug] Manually calling refresh()");
                session.refresh().then(() => {
                  console.log("[Debug] Refresh complete");
                  // Re-fetch session check
                  fetch("/api/auth/session", { credentials: "include" })
                    .then((res) => res.json())
                    .then(setSessionCheck);
                });
              }}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded text-white font-medium"
            >
              Manually Refresh Session
            </button>

            <button
              onClick={() => {
                console.log("[Debug] Calling logout()");
                session.logout().then(() => {
                  console.log("[Debug] Logout complete");
                  window.location.href = "/";
                });
              }}
              className="ml-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-white font-medium"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Diagnostic Info */}
        <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
          <h2 className="text-xl font-semibold mb-4 text-amber-500">Diagnosis</h2>
          <ul className="space-y-2 text-sm">
            <li className={session.authenticated ? "text-green-400" : "text-red-400"}>
              {session.authenticated ? "✅" : "❌"} SessionContext.authenticated
            </li>
            <li className={account ? "text-green-400" : "text-red-400"}>
              {account ? "✅" : "❌"} Wallet connected
            </li>
            <li className={sessionCheck?.authenticated ? "text-green-400" : "text-red-400"}>
              {sessionCheck?.authenticated ? "✅" : "❌"} /api/auth/session returns authenticated
            </li>
            <li className={!session.loading ? "text-green-400" : "text-yellow-400"}>
              {!session.loading ? "✅" : "⏳"} Session loading complete
            </li>
          </ul>

          {!session.authenticated && !!account && !session.loading && (
            <div className="mt-4 p-4 bg-red-900/30 border border-red-500 rounded">
              <p className="text-red-400 font-semibold">
                ⚠️ Problem Detected: Wallet is connected but session not authenticated
              </p>
              <p className="text-sm text-gray-300 mt-2">
                This means either:
              </p>
              <ul className="list-disc list-inside text-sm text-gray-300 mt-1">
                <li>ConnectButton auth flow didn't complete SIWE</li>
                <li>/api/auth/verify failed</li>
                <li>Cookie wasn't set</li>
                <li>SessionContext didn't update</li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
