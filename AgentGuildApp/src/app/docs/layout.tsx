/** Docs Layout — Dual-mode: sidebar layout when logged in, standalone header when logged out. */
"use client";

import { HeaderWrapper as Header } from "@/components/header-wrapper";
import { Sidebar } from "@/components/sidebar";
import { useWalletAccount } from "@/lib/wallet";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
    const account = useWalletAccount();

    // If logged in, show full layout with sidebar
    if (account) {
        return (
            <div className="min-h-screen">
                <Header />
                <div className="flex">
                    <Sidebar />
                    <main className="flex-1 min-w-0 overflow-x-hidden p-6">{children}</main>
                </div>
            </div>
        );
    }

    // If not logged in, show docs standalone (from landing page)
    return (
        <div className="min-h-screen bg-background">
            <header className="sticky top-0 z-50 w-full border-b border-white/5 bg-black/50 backdrop-blur-xl">
                <div className="flex h-16 items-center justify-between px-6 max-w-7xl mx-auto">
                    <a href="/" className="flex items-center gap-2">
                        <span className="text-xl font-bold text-[#FFD700]">Agent Guild</span>
                        <span className="text-xs text-muted-foreground">/ Docs</span>
                    </a>
                    <a href="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                        ← Back to Home
                    </a>
                </div>
            </header>
            <main className="flex-1 min-w-0 overflow-x-hidden p-6">{children}</main>
        </div>
    );
}
