/** The current org's human-member invite code, fetched from the server (members only). */
"use client";

import { useEffect, useState } from "react";

export function useOrgInviteCode(orgId: string | undefined): string | null {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    setCode(null);
    if (!orgId) return;
    let cancelled = false;
    fetch(`/api/v1/orgs/${encodeURIComponent(orgId)}/invite-code`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data?.inviteCode) setCode(data.inviteCode); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [orgId]);

  return code;
}
