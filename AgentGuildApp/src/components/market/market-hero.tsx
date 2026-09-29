"use client";

import { Star, Download, Search, Store } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { AgentPackage, CommunityMarketItem } from "@/lib/market/types";

interface MarketHeroProps {
    featuredAgents: AgentPackage[];
    featuredCommunity: CommunityMarketItem[];
    inventoryCount: number;
    search: string;
    onSearchChange: (value: string) => void;
    onSelectPersona: (persona: AgentPackage) => void;
}

export function MarketHero({
    featuredAgents, featuredCommunity, inventoryCount,
    search, onSearchChange, onSelectPersona,
}: MarketHeroProps) {
    const hasFeatured = featuredAgents.length > 0 || featuredCommunity.length > 0;

    return (
        <div className="relative mb-8 rounded-2xl overflow-hidden">
            {/* Gradient background */}
            <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 via-purple-500/5 to-cyan-500/5" />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(251,191,36,0.08),transparent_50%)]" />

            <div className="relative px-6 sm:px-8 py-8 sm:py-10">
                {/* Title row */}
                <div className="flex items-start justify-between mb-6">
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-3 mb-1.5">
                            <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
                                <Store className="h-6 w-6 text-amber-500" />
                            </div>
                            Marketplace
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            Discover agents, mods, plugins, and skills for your swarm
                        </p>
                    </div>
                    <Badge className="bg-amber-500/10 text-amber-500 border-amber-500/20 text-sm shrink-0">
                        {inventoryCount} owned
                    </Badge>
                </div>

                {/* Global search */}
                <div className="relative max-w-2xl mb-8">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                    <Input
                        placeholder="Search all agents, mods, plugins, skills..."
                        value={search}
                        onChange={(e) => onSearchChange(e.target.value)}
                        className="pl-12 h-12 text-base bg-background/80 backdrop-blur-sm border-border/50 rounded-xl"
                    />
                </div>

                {/* Featured carousel */}
                {hasFeatured && (
                    <div>
                        <div className="flex items-center gap-2 mb-3">
                            <div className="p-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
                                <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
                            </div>
                            <h2 className="text-sm font-semibold">Featured & Trending</h2>
                        </div>
                        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none">
                            {featuredAgents.map((agent) => (
                                <Card
                                    key={`feat-agent-${agent.id}`}
                                    className="min-w-[300px] max-w-[340px] p-4 bg-gradient-to-br from-purple-500/8 via-card to-cyan-500/5 border-purple-500/20 cursor-pointer hover:border-purple-500/40 hover:shadow-lg hover:shadow-purple-500/5 transition-all shrink-0 group"
                                    onClick={() => onSelectPersona(agent)}
                                >
                                    <div className="flex items-center gap-3 mb-3">
                                        <span className="text-3xl group-hover:scale-110 transition-transform">{agent.icon}</span>
                                        <div className="min-w-0 flex-1">
                                            <h3 className="font-bold text-sm truncate">{agent.name}</h3>
                                            <p className="text-[10px] text-purple-400">Agent</p>
                                        </div>
                                        {agent.pricing.configPurchase ? (
                                            <Badge className="text-[10px] bg-amber-500/20 text-amber-400 border-amber-500/30 shrink-0">
                                                ${agent.pricing.configPurchase}
                                            </Badge>
                                        ) : (
                                            <Badge className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shrink-0">
                                                Free
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{agent.description}</p>
                                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                        <span className="flex items-center gap-0.5">
                                            <Download className="h-2.5 w-2.5" /> {agent.installCount ?? 0} installs
                                        </span>
                                        {(agent.avgRating ?? 0) > 0 && (
                                            <span className="flex items-center gap-0.5">
                                                <Star className="h-2.5 w-2.5 text-amber-400 fill-amber-400" />
                                                {agent.avgRating.toFixed(1)} ({agent.ratingCount})
                                            </span>
                                        )}
                                    </div>
                                </Card>
                            ))}
                            {featuredCommunity.map((item) => (
                                <Card
                                    key={`feat-community-${item.id}`}
                                    className="min-w-[300px] max-w-[340px] p-4 bg-gradient-to-br from-amber-500/8 via-card to-cyan-500/5 border-amber-500/20 hover:border-amber-500/40 hover:shadow-lg hover:shadow-amber-500/5 transition-all shrink-0"
                                >
                                    <div className="flex items-center gap-3 mb-3">
                                        <span className="text-3xl">{item.icon}</span>
                                        <div className="min-w-0 flex-1">
                                            <h3 className="font-bold text-sm text-foreground truncate">{item.name}</h3>
                                            <p className="text-[10px] text-amber-400 capitalize">{item.type}</p>
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{item.description}</p>
                                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                        <span className="flex items-center gap-0.5">
                                            <Download className="h-2.5 w-2.5" /> {item.installCount ?? 0}
                                        </span>
                                        {(item.avgRating ?? 0) > 0 && (
                                            <span className="flex items-center gap-0.5">
                                                <Star className="h-2.5 w-2.5 text-amber-400 fill-amber-400" />
                                                {item.avgRating!.toFixed(1)} ({item.ratingCount ?? 0})
                                            </span>
                                        )}
                                    </div>
                                </Card>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
