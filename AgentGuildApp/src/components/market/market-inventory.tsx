"use client";

import { Store, Puzzle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Skill, OwnedItem, MarketSubscription, CommunityMarketItem } from "@/lib/market/types";
import { MarketItemCard } from "./market-item-card";
import { MarketGrid } from "./market-grid";

interface MarketInventoryProps {
    allItems: Skill[];
    inventory: OwnedItem[];
    inventoryMap: Map<string, OwnedItem>;
    subscriptionMap: Map<string, MarketSubscription>;
    communityItemMap: Map<string, CommunityMarketItem>;
    busyId: string | null;
    onGet: (skillId: string) => void;
    onRemove: (item: OwnedItem) => void;
    onSubscribe: (item: Skill) => void;
    onCancelSub: (sub: MarketSubscription) => void;
    onRate: (id: string, name: string) => void;
    onBrowse: () => void;
}

export function MarketInventory({
    allItems, inventory, inventoryMap, subscriptionMap, communityItemMap,
    busyId, onGet, onRemove, onSubscribe, onCancelSub, onRate, onBrowse,
}: MarketInventoryProps) {
    const ownedItems = allItems.filter((s) => inventoryMap.has(s.id));

    // Group by type
    const grouped = new Map<string, Skill[]>();
    for (const item of ownedItems) {
        const type = item.type;
        if (!grouped.has(type)) grouped.set(type, []);
        grouped.get(type)!.push(item);
    }

    if (inventory.length === 0) {
        return (
            <Card className="p-12 text-center bg-card border-border border-dashed">
                <Store className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-semibold mb-2">Your inventory is empty</h3>
                <p className="text-sm text-muted-foreground mb-6">
                    Browse the market to get mods, plugins, and skills for your swarm.
                </p>
                <Button onClick={onBrowse} className="bg-amber-500 hover:bg-amber-600 text-black gap-2">
                    <Puzzle className="h-4 w-4" /> Browse Market
                </Button>
            </Card>
        );
    }

    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    You own <span className="text-foreground font-medium">{inventory.length}</span> items
                </p>
                <Badge variant="outline" className="text-xs">{inventory.length} owned</Badge>
            </div>

            {Array.from(grouped.entries()).map(([type, items]) => (
                <div key={type}>
                    <h3 className="text-sm font-semibold capitalize mb-3 text-muted-foreground">{type}s</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                        {items.map((item) => {
                            const subKey = item.id.startsWith("community-") ? item.id.slice(10) : item.id;
                            const sub = subscriptionMap.get(subKey);
                            return (
                                <MarketItemCard
                                    key={item.id}
                                    item={item}
                                    owned={inventoryMap.get(item.id)}
                                    subscription={sub}
                                    avgRating={communityItemMap.get(item.id)?.avgRating}
                                    ratingCount={communityItemMap.get(item.id)?.ratingCount}
                                    installCount={communityItemMap.get(item.id)?.installCount}
                                    onGet={() => onGet(item.id)}
                                    onRemove={() => {
                                        const own = inventoryMap.get(item.id);
                                        if (own) onRemove(own);
                                    }}
                                    onSubscribe={() => onSubscribe(item)}
                                    onCancelSub={() => { if (sub) onCancelSub(sub); }}
                                    onRate={() => {
                                        const cId = item.id.startsWith("community-") ? item.id.slice(10) : item.id;
                                        onRate(cId, item.name);
                                    }}
                                    busy={busyId === item.id}
                                />
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}
