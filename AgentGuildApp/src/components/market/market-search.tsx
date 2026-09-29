"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SortOption, SourceFilter } from "@/lib/market/types";

interface MarketSearchProps {
    search: string;
    onSearchChange: (value: string) => void;
    sortBy: SortOption;
    onSortChange: (sort: SortOption) => void;
    sourceFilter: SourceFilter;
    onSourceChange: (source: SourceFilter) => void;
    placeholder?: string;
    resultCounts?: Record<string, number>;
    accentColor?: "amber" | "purple";
}

export function MarketSearch({
    search, onSearchChange,
    sortBy, onSortChange,
    sourceFilter, onSourceChange,
    placeholder = "Search...",
    resultCounts,
    accentColor = "amber",
}: MarketSearchProps) {
    const activeClass = accentColor === "purple"
        ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
        : "bg-amber-500/20 text-amber-400 border border-amber-500/30";

    return (
        <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                    placeholder={placeholder}
                    value={search}
                    onChange={(e) => onSearchChange(e.target.value)}
                    className="pl-9"
                />
            </div>

            <Select value={sortBy} onValueChange={(v) => onSortChange(v as SortOption)}>
                <SelectTrigger className="w-[150px] shrink-0">
                    <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="name">Name</SelectItem>
                    <SelectItem value="type">Type</SelectItem>
                    <SelectItem value="rating">Top Rated</SelectItem>
                    <SelectItem value="installs">Most Installed</SelectItem>
                    <SelectItem value="trending">Trending</SelectItem>
                </SelectContent>
            </Select>

            <div className="flex items-center gap-1 shrink-0">
                {(["all", "verified", "community"] as const).map((s) => (
                    <button
                        key={s}
                        onClick={() => onSourceChange(s)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${sourceFilter === s
                            ? activeClass
                            : "bg-muted/50 text-muted-foreground hover:bg-muted border border-transparent"
                        }`}
                    >
                        {s === "all" ? "All" : s === "verified" ? "Verified" : "Community"}
                    </button>
                ))}
            </div>

            {/* Result count badges for global search */}
            {resultCounts && Object.keys(resultCounts).length > 0 && (
                <div className="flex items-center gap-1.5 w-full">
                    {Object.entries(resultCounts).filter(([, c]) => c > 0).map(([type, count]) => (
                        <Badge key={type} variant="outline" className="text-[10px] capitalize">
                            {count} {type}{count !== 1 ? "s" : ""}
                        </Badge>
                    ))}
                </div>
            )}
        </div>
    );
}
