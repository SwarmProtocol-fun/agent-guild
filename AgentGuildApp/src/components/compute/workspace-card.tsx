"use client";

import Link from "next/link";
import { FolderKanban } from "lucide-react";
import type { Workspace } from "@/lib/compute/types";

interface WorkspaceCardProps {
  workspace: Workspace;
  computerCount?: number;
}

export function WorkspaceCard({ workspace, computerCount }: WorkspaceCardProps) {
  return (
    <Link
      href={`/compute/workspaces/${workspace.id}`}
      className="block rounded-xl border border-border bg-card p-4 transition-all hover:border-muted-foreground/50 hover:shadow-lg"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <FolderKanban className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="font-semibold text-sm">{workspace.name}</h3>
          {workspace.description && (
            <p className="text-xs text-muted-foreground line-clamp-1">{workspace.description}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        {computerCount !== undefined && (
          <span>{computerCount} computer{computerCount !== 1 ? "s" : ""}</span>
        )}
        <span className="capitalize">{workspace.planTier} plan</span>
      </div>
    </Link>
  );
}
