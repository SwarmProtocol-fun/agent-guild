/** DashboardShell — Layout wrapper. Skin components load dynamically from installed mods. */
"use client";

import { useSkin } from "@/contexts/SkinContext";
import { HeaderWrapper as Header } from "@/components/header-wrapper";
import { Sidebar } from "@/components/sidebar";
import { DashboardBackground } from "@/components/dashboard-bg";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  // Skins are now loaded as marketplace mods — default chrome only in core
  const { skin: _skin } = useSkin();

  return (
    <div className="min-h-screen relative bg-background">
      <DashboardBackground />
      <div className="relative z-10 flex flex-col h-screen">
        <Header />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 min-w-0 overflow-y-auto px-2 py-1">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
