"use client";

import {
    Bot, Wrench, Plug, Puzzle, Palette, Server,
    Layers, Package, ChevronRight,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { MarketCategory, MarketView } from "@/lib/market/types";

interface CategoryGridProps {
    counts: Record<string, number>;
    onSelect: (view: MarketView) => void;
    inventoryCount: number;
    submissionCount: number;
}

const CATEGORIES: {
    key: MarketCategory;
    label: string;
    description: string;
    icon: typeof Bot;
    gradient: string;
    borderHover: string;
    iconColor: string;
}[] = [
    {
        key: "mods",
        label: "Mods",
        description: "Extend agents with new capabilities",
        icon: Wrench,
        gradient: "from-amber-500/10 via-amber-500/5 to-orange-500/5",
        borderHover: "hover:border-amber-500/30",
        iconColor: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    },
    {
        key: "agents",
        label: "Agents",
        description: "Pre-built personas & agent templates",
        icon: Bot,
        gradient: "from-purple-500/10 via-purple-500/5 to-cyan-500/5",
        borderHover: "hover:border-purple-500/30",
        iconColor: "text-purple-400 bg-purple-500/10 border-purple-500/20",
    },
    {
        key: "plugins",
        label: "Plugins",
        description: "Connect to external tools & services",
        icon: Plug,
        gradient: "from-blue-500/10 via-blue-500/5 to-indigo-500/5",
        borderHover: "hover:border-blue-500/30",
        iconColor: "text-blue-400 bg-blue-500/10 border-blue-500/20",
    },
    {
        key: "skills",
        label: "Skills",
        description: "Add new abilities to your agents",
        icon: Puzzle,
        gradient: "from-cyan-500/10 via-cyan-500/5 to-teal-500/5",
        borderHover: "hover:border-cyan-500/30",
        iconColor: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
    },
    {
        key: "skins",
        label: "Skins",
        description: "Customize your dashboard look & feel",
        icon: Palette,
        gradient: "from-pink-500/10 via-pink-500/5 to-rose-500/5",
        borderHover: "hover:border-pink-500/30",
        iconColor: "text-pink-400 bg-pink-500/10 border-pink-500/20",
    },
    {
        key: "compute",
        label: "Compute",
        description: "GPU, CPU, and storage resources",
        icon: Server,
        gradient: "from-emerald-500/10 via-emerald-500/5 to-green-500/5",
        borderHover: "hover:border-emerald-500/30",
        iconColor: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    },
];

export function CategoryGrid({ counts, onSelect, inventoryCount, submissionCount }: CategoryGridProps) {
    return (
        <div className="space-y-4">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Browse by Category</h2>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {CATEGORIES.map(({ key, label, description, icon: Icon, gradient, borderHover, iconColor }) => (
                    <Card
                        key={key}
                        onClick={() => onSelect(key)}
                        className={`p-4 bg-gradient-to-br ${gradient} border-border ${borderHover} cursor-pointer transition-all group hover:shadow-lg`}
                    >
                        <div className="flex items-start justify-between mb-3">
                            <div className={`p-2 rounded-lg border ${iconColor}`}>
                                <Icon className="h-5 w-5" />
                            </div>
                            <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
                        </div>
                        <h3 className="font-semibold text-sm mb-0.5">{label}</h3>
                        <p className="text-[11px] text-muted-foreground line-clamp-2 mb-2">{description}</p>
                        <Badge variant="outline" className="text-[10px]">
                            {counts[key] ?? 0} items
                        </Badge>
                    </Card>
                ))}

                {/* Bundles card */}
                <Card
                    onClick={() => onSelect("bundles")}
                    className="p-4 bg-gradient-to-br from-amber-500/5 to-orange-500/5 border-border hover:border-amber-500/20 cursor-pointer transition-all group hover:shadow-lg"
                >
                    <div className="flex items-start justify-between mb-3">
                        <div className="p-2 rounded-lg border text-amber-400 bg-amber-500/10 border-amber-500/20">
                            <Layers className="h-5 w-5" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
                    </div>
                    <h3 className="font-semibold text-sm mb-0.5">Bundles</h3>
                    <p className="text-[11px] text-muted-foreground line-clamp-2 mb-2">Pre-packaged skill collections</p>
                    <Badge variant="outline" className="text-[10px]">
                        {counts["bundles"] ?? 0} bundles
                    </Badge>
                </Card>

                {/* Inventory card */}
                <Card
                    onClick={() => onSelect("inventory")}
                    className="p-4 bg-gradient-to-br from-emerald-500/5 to-teal-500/5 border-border hover:border-emerald-500/20 cursor-pointer transition-all group hover:shadow-lg"
                >
                    <div className="flex items-start justify-between mb-3">
                        <div className="p-2 rounded-lg border text-emerald-400 bg-emerald-500/10 border-emerald-500/20">
                            <Package className="h-5 w-5" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
                    </div>
                    <h3 className="font-semibold text-sm mb-0.5">My Inventory</h3>
                    <p className="text-[11px] text-muted-foreground line-clamp-2 mb-2">Your installed items</p>
                    <Badge variant="outline" className="text-[10px] border-emerald-500/20 text-emerald-400">
                        {inventoryCount} owned
                    </Badge>
                </Card>
            </div>
        </div>
    );
}
