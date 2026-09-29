"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOrg } from "@/contexts/OrgContext";
import type { Workspace } from "@/lib/compute/types";
import { CreateComputerWizard } from "@/components/compute/create-computer-wizard";
const trackComputeEvent = (..._args: unknown[]) => {}; // posthog removed

export default function NewComputerPage() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg?.id) return;
    fetch(`/api/compute/workspaces?orgId=${currentOrg.id}`)
      .then((r) => r.json())
      .then((data) => { if (data.ok) setWorkspaces(data.workspaces); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [currentOrg?.id]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 p-6">
        <p className="text-sm text-muted-foreground">
          Create a workspace first before adding computers.
        </p>
        <button
          onClick={async () => {
            const res = await fetch("/api/compute/workspaces", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                orgId: currentOrg?.id,
                name: "Default Workspace",
                description: "Auto-created workspace",
              }),
            });
            if (res.ok) {
              const data = await res.json();
              setWorkspaces([{ id: data.id, orgId: currentOrg?.id || "", ownerUserId: "", name: "Default Workspace", slug: "default", description: "", planTier: "free", defaultProvider: "e2b", defaultAutoStopMinutes: 30, allowedInstanceSizes: ["small", "medium", "large"], staticIpEnabled: false, createdAt: null, updatedAt: null }]);
            }
          }}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Create Default Workspace
        </button>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">New Computer</h1>
      <CreateComputerWizard
        workspaces={workspaces}
        onCreated={(id) => { trackComputeEvent("computer_created", { computerId: id }); router.push(`/compute/computers/${id}`); }}
        onCancel={() => router.push("/compute/computers")}
      />
    </div>
  );
}
