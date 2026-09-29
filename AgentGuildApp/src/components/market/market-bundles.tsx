"use client";

import { Check, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Skill, OwnedItem } from "@/lib/market/types";
import { SKILL_BUNDLES } from "@/lib/skills";

interface MarketBundlesProps {
    allItems: Skill[];
    inventoryMap: Map<string, OwnedItem>;
    busyId: string | null;
    onGetBundle: (bundleId: string) => void;
}

export function MarketBundles({ allItems, inventoryMap, busyId, onGetBundle }: MarketBundlesProps) {
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-muted-foreground">
                    Pre-packaged skill collections to get started fast
                </p>
                <Badge variant="outline" className="text-xs">{SKILL_BUNDLES.length} bundles</Badge>
            </div>
            {SKILL_BUNDLES.map((bundle) => {
                const bundleSkills = allItems.filter((s) => bundle.skillIds.includes(s.id));
                const allOwned = bundle.skillIds.every((id) => inventoryMap.has(id));
                return (
                    <Card key={bundle.id} className="p-5 bg-card border-border">
                        <div className="flex items-start gap-4">
                            <div className="text-3xl shrink-0 w-12 h-12 flex items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20">
                                {bundle.icon}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-bold text-base">{bundle.name}</h3>
                                    <Badge variant="outline" className="text-[10px]">{bundle.skillIds.length} items</Badge>
                                    {allOwned && (
                                        <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                                            <Check className="h-2.5 w-2.5 mr-0.5" /> Owned
                                        </Badge>
                                    )}
                                </div>
                                <p className="text-sm text-muted-foreground mb-3">{bundle.description}</p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    {bundleSkills.map((s) => (
                                        <span
                                            key={s.id}
                                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${inventoryMap.has(s.id)
                                                ? "bg-emerald-500/10 text-emerald-400"
                                                : "bg-muted/50 text-muted-foreground"
                                            }`}
                                        >
                                            {s.icon} {s.name}
                                            {inventoryMap.has(s.id) && <Check className="h-3 w-3" />}
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div className="shrink-0">
                                {allOwned ? (
                                    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                                        <Check className="h-3 w-3 mr-1" /> All Owned
                                    </Badge>
                                ) : (
                                    <Button
                                        size="sm"
                                        onClick={() => onGetBundle(bundle.id)}
                                        disabled={busyId === bundle.id}
                                        className="bg-amber-500 hover:bg-amber-600 text-black gap-1"
                                    >
                                        {busyId === bundle.id ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                            <Download className="h-3 w-3" />
                                        )}
                                        Get Bundle
                                    </Button>
                                )}
                            </div>
                        </div>
                    </Card>
                );
            })}
        </div>
    );
}
