"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "@/contexts/SessionContext";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { authenticated, loading } = useSession();

  useEffect(() => {
    // If session check is still loading, wait
    if (loading) return;

    // If authenticated, we're done -> go to dashboard
    if (authenticated) {
      router.replace("/dashboard");
      return;
    }

    // If not authenticated and no OAuth redirect params are present,
    // the user shouldn't be here -> send back to landing page.
    const hasOAuthParams = searchParams.has("walletId") && searchParams.has("authResult");
    if (!hasOAuthParams) {
      router.replace("/");
    }
  }, [authenticated, loading, router, searchParams]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-4">
      <Loader2 className="w-12 h-12 animate-spin text-primary" />
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold text-foreground/80 tracking-tight">Authenticating...</h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm mx-auto">
          Please wait while we verify your session securely.
        </p>
      </div>
    </div>
  );
}
