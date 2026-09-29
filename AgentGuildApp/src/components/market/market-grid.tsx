"use client";

import { useRef, useState, useEffect } from "react";
import { Search, Store } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface MarketGridProps {
    loading: boolean;
    children: React.ReactNode[];
    resultCount: number;
    resultLabel: string;
    searchQuery?: string;
    emptyAction?: { label: string; onClick: () => void };
    emptyIcon?: React.ReactNode;
    emptyTitle?: string;
    emptyDescription?: string;
}

export function MarketGrid({
    loading,
    children,
    resultCount,
    resultLabel,
    searchQuery,
    emptyAction,
    emptyIcon,
    emptyTitle,
    emptyDescription,
}: MarketGridProps) {
    const [visibleCount, setVisibleCount] = useState(24);
    const sentinelRef = useRef<HTMLDivElement>(null);

    // Reset visible count when children change
    useEffect(() => {
        setVisibleCount(24);
    }, [resultCount, searchQuery]);

    // Infinite scroll via IntersectionObserver
    useEffect(() => {
        if (visibleCount >= children.length) return;
        const sentinel = sentinelRef.current;
        if (!sentinel) return;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                setVisibleCount((prev) => Math.min(prev + 20, children.length));
            }
        }, { rootMargin: "200px" });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [visibleCount, children.length]);

    if (loading) {
        return (
            <div>
                <div className="flex items-center gap-2 mb-4">
                    <div className="h-4 w-32 bg-muted/50 rounded animate-pulse" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                    {Array.from({ length: 8 }, (_, i) => (
                        <Card key={i} className="p-4 bg-card/80 border-border">
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-lg bg-muted/50 animate-pulse shrink-0" />
                                <div className="flex-1 space-y-2">
                                    <div className="h-4 w-2/3 bg-muted/50 rounded animate-pulse" />
                                    <div className="h-3 w-full bg-muted/30 rounded animate-pulse" />
                                    <div className="flex gap-2 mt-1">
                                        <div className="h-5 w-16 bg-muted/30 rounded-full animate-pulse" />
                                        <div className="h-5 w-14 bg-muted/30 rounded-full animate-pulse" />
                                    </div>
                                </div>
                            </div>
                        </Card>
                    ))}
                </div>
            </div>
        );
    }

    if (children.length === 0) {
        return (
            <Card className="p-12 text-center bg-card border-border border-dashed">
                {emptyIcon || <Search className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />}
                <h3 className="text-lg font-semibold mb-2">{emptyTitle || "No items found"}</h3>
                <p className="text-sm text-muted-foreground mb-6">
                    {emptyDescription || (searchQuery ? `No items match "${searchQuery}"` : "Nothing here yet.")}
                </p>
                {emptyAction && (
                    <Button onClick={emptyAction.onClick} className="bg-amber-500 hover:bg-amber-600 text-black gap-2">
                        {emptyAction.label}
                    </Button>
                )}
            </Card>
        );
    }

    const visible = children.slice(0, visibleCount);

    return (
        <div>
            <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-muted-foreground">
                    Showing <span className="text-foreground font-medium">{resultCount}</span> {resultLabel}
                    {searchQuery && (
                        <> for <span className="text-foreground font-medium">&ldquo;{searchQuery}&rdquo;</span></>
                    )}
                </p>
                {resultCount > 0 && (
                    <Badge variant="outline" className="text-xs">{resultCount}</Badge>
                )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                {visible}
            </div>
            {visibleCount < children.length && (
                <div ref={sentinelRef} className="flex justify-center py-6">
                    <p className="text-xs text-muted-foreground">Loading more...</p>
                </div>
            )}
        </div>
    );
}
