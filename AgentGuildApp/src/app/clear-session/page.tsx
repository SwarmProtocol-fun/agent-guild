"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function ClearSessionPage() {
  const router = useRouter();
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");

  const handleClearSession = async () => {
    setClearing(true);
    setMessage("");

    try {
      // Call logout endpoint to clear session
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        setMessage("✅ Session cleared! Redirecting to home...");
        setTimeout(() => {
          router.push("/");
        }, 1500);
      } else {
        setMessage("❌ Failed to clear session");
      }
    } catch (err) {
      setMessage("❌ Error: " + String(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-black to-gray-900">
      <div className="max-w-md w-full p-8 bg-gray-800/50 rounded-lg border border-amber-500/20 text-center">
        <h1 className="text-2xl font-bold text-amber-500 mb-4">
          Clear Session
        </h1>
        <p className="text-gray-300 mb-6">
          Click the button below to clear your current session and test the new
          SIWE authentication flow.
        </p>
        <Button
          onClick={handleClearSession}
          disabled={clearing}
          className="w-full bg-amber-500 hover:bg-amber-600 text-black font-semibold"
        >
          {clearing ? "Clearing..." : "Clear Session & Logout"}
        </Button>
        {message && (
          <p className="mt-4 text-sm text-gray-300">{message}</p>
        )}
      </div>
    </div>
  );
}
