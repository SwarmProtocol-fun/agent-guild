/** Market — Redesigned marketplace with hero, global search, and category navigation. */
"use client";

import { Suspense } from "react";
import Link from "next/link";
import { Store, ArrowLeft, Bot, Activity, Fingerprint, TrendingUp, Shield, Zap } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMarketplace } from "@/hooks/useMarketplace";
import { MarketHero } from "@/components/market/market-hero";
import { MarketSearch } from "@/components/market/market-search";
import { CategoryGrid } from "@/components/market/category-grid";
import { MarketSubCategories } from "@/components/market/market-sub-categories";
import { MarketItemCard } from "@/components/market/market-item-card";
import { MarketGrid } from "@/components/market/market-grid";
import { MarketBundles } from "@/components/market/market-bundles";
import { MarketInventory } from "@/components/market/market-inventory";
import { MarketSubmissions } from "@/components/market/market-submissions";
import { PersonaCard } from "@/components/market/persona-card";
import { PersonaDetailDialog } from "@/components/market/persona-detail-dialog";
import { ApplyPersonaDialog } from "@/components/market/apply-persona-dialog";
import { SubscribeDialog } from "@/components/market/subscribe-dialog";
import { RatingDialog } from "@/components/market/rating-dialog";
import { CryptoCheckoutDialog } from "@/components/marketplace/crypto-checkout-dialog";
const trackMarketplaceEvent = (..._args: unknown[]) => {}; // posthog removed
import type { Agent } from "@/lib/firestore";

// ── Category labels ──

const CATEGORY_LABELS: Record<string, string> = {
    agents: "Agents",
    mods: "Mods",
    plugins: "Plugins",
    skills: "Skills",
    skins: "Skins",
    compute: "Compute",
    bundles: "Bundles",
    inventory: "Inventory",
    submit: "Submissions",
};

// ── Agent card (for "Your Agents" section) ──

function AgentMarketCard({ agent }: { agent: Agent }) {
    const statusColor = agent.status === "online"
        ? "bg-emerald-500" : agent.status === "busy"
            ? "bg-amber-500" : "bg-zinc-500";

    return (
        <Card className="p-0 bg-card border-border transition-all hover:border-cyan-500/20 group overflow-hidden">
            <div className="p-4">
                <div className="flex items-start gap-3 mb-3">
                    <div className="relative shrink-0">
                        {agent.avatarUrl ? (
                            <img src={agent.avatarUrl} alt={agent.name} className="w-10 h-10 rounded-lg object-cover border border-border" />
                        ) : (
                            <div className="w-10 h-10 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-lg">
                                <Bot className="h-5 w-5 text-cyan-400" />
                            </div>
                        )}
                        <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-card ${statusColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                            <h3 className="font-semibold text-sm truncate">{agent.name}</h3>
                            <Badge variant="outline" className="text-[10px]">{agent.type}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-1">
                            {agent.bio || agent.description || `${agent.type} agent`}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mb-3">
                    {agent.asn && (
                        <Badge className="text-[10px] bg-cyan-500/10 text-cyan-400 border-cyan-500/20 font-mono">
                            <Fingerprint className="h-2.5 w-2.5 mr-0.5" />
                            {agent.asn.split("-").slice(0, 4).join("-")}
                        </Badge>
                    )}
                    {agent.creditScore && (
                        <Badge className={`text-[10px] ${agent.creditScore >= 750 ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10" : agent.creditScore >= 600 ? "text-amber-400 border-amber-500/20 bg-amber-500/10" : "text-red-400 border-red-500/20 bg-red-500/10"}`}>
                            <TrendingUp className="h-2.5 w-2.5 mr-0.5" />Credit: {agent.creditScore}
                        </Badge>
                    )}
                    {agent.trustScore != null && (
                        <Badge className="text-[10px] bg-blue-500/10 text-blue-400 border-blue-500/20">
                            <Shield className="h-2.5 w-2.5 mr-0.5" />Trust: {agent.trustScore}
                        </Badge>
                    )}
                    {agent.onChainRegistered && (
                        <Badge variant="outline" className="text-[10px] border-purple-500/20 text-purple-400">
                            <Zap className="h-2.5 w-2.5 mr-0.5" />On-Chain
                        </Badge>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <Link href="/agents" className="flex-1">
                        <Button size="sm" variant="outline" className="w-full h-7 text-xs gap-1 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10">
                            <Bot className="h-3 w-3" /> View Agent
                        </Button>
                    </Link>
                    <Badge className={`text-[10px] ${agent.status === "online" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : agent.status === "busy" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" : "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"}`}>
                        <Activity className="h-2.5 w-2.5 mr-0.5" />{agent.status}
                    </Badge>
                </div>
            </div>
        </Card>
    );
}

// ── Main page content ──

function MarketPageInner() {
    const m = useMarketplace();

    if (!m.isAuthenticated) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <Store className="h-12 w-12 opacity-30" />
                <p>Sign in to browse the market</p>
            </div>
        );
    }

    const categoryLabel = m.filters.category ? CATEGORY_LABELS[m.filters.category] || m.filters.category : "";

    return (
        <div className="w-full px-4 sm:px-6 py-6">
            {/* ─── Discovery Home ─── */}
            {m.isDiscoveryHome && !m.isGlobalSearch && (
                <>
                    <MarketHero
                        featuredAgents={m.featuredAgents}
                        featuredCommunity={m.featuredCommunity}
                        inventoryCount={m.inventory.length}
                        search={m.filters.search}
                        onSearchChange={(v) => m.setFilters({ search: v })}
                        onSelectPersona={m.setSelectedPersona}
                    />
                    <CategoryGrid
                        counts={m.categoryCounts}
                        onSelect={(view) => {
                            m.setFilters({ category: view, subCategory: "All", search: "" });
                            trackMarketplaceEvent("tab_changed", { tab: view });
                        }}
                        inventoryCount={m.inventory.length}
                        submissionCount={m.userSubmissions.length}
                    />
                </>
            )}

            {/* ─── Global Search Results ─── */}
            {m.isGlobalSearch && m.globalSearchResults && (
                <div className="space-y-8">
                    <button
                        onClick={() => m.setFilters({ search: "", category: null })}
                        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <ArrowLeft className="h-4 w-4" /> Back to Marketplace
                    </button>

                    <MarketSearch
                        search={m.filters.search}
                        onSearchChange={(v) => m.setFilters({ search: v })}
                        sortBy={m.filters.sort}
                        onSortChange={(v) => m.setFilters({ sort: v })}
                        sourceFilter={m.filters.source}
                        onSourceChange={(v) => m.setFilters({ source: v })}
                        placeholder="Search all items..."
                        resultCounts={{
                            agent: m.globalSearchResults.agents.length,
                            mod: m.globalSearchResults.mods.length,
                            plugin: m.globalSearchResults.plugins.length,
                            skill: m.globalSearchResults.skills.length,
                            skin: m.globalSearchResults.skins.length,
                        }}
                    />

                    {m.globalSearchResults.totalCount === 0 ? (
                        <div className="text-center py-12 text-muted-foreground">
                            <Store className="h-8 w-8 mx-auto mb-3 opacity-30" />
                            <p>No results for &ldquo;{m.filters.search}&rdquo;</p>
                        </div>
                    ) : (
                        <>
                            {m.globalSearchResults.agents.length > 0 && (
                                <section>
                                    <div className="flex items-center justify-between mb-3">
                                        <h2 className="text-sm font-semibold">Agents ({m.globalSearchResults.agents.length})</h2>
                                        <button
                                            onClick={() => m.setFilters({ category: "agents", search: m.filters.search })}
                                            className="text-xs text-amber-400 hover:text-amber-300"
                                        >
                                            View all
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                        {m.globalSearchResults.agents.slice(0, 4).map((p) => (
                                            <PersonaCard key={p.id} persona={p} onSelect={m.setSelectedPersona} />
                                        ))}
                                    </div>
                                </section>
                            )}

                            {(["mods", "plugins", "skills", "skins", "compute"] as const).map((type) => {
                                const key = type as keyof typeof m.globalSearchResults;
                                const items = m.globalSearchResults![key] as typeof m.allItems;
                                if (!items || items.length === 0) return null;
                                return (
                                    <section key={type}>
                                        <div className="flex items-center justify-between mb-3">
                                            <h2 className="text-sm font-semibold">{CATEGORY_LABELS[type]} ({items.length})</h2>
                                            <button
                                                onClick={() => m.setFilters({ category: type, search: m.filters.search })}
                                                className="text-xs text-amber-400 hover:text-amber-300"
                                            >
                                                View all
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                                            {items.slice(0, 4).map((item) => {
                                                const subKey = item.id.startsWith("community-") ? item.id.slice(10) : item.id;
                                                return (
                                                    <MarketItemCard
                                                        key={item.id}
                                                        item={item}
                                                        owned={m.inventoryMap.get(item.id)}
                                                        subscription={m.subscriptionMap.get(subKey)}
                                                        avgRating={m.communityItemMap.get(item.id)?.avgRating}
                                                        ratingCount={m.communityItemMap.get(item.id)?.ratingCount}
                                                        installCount={m.communityItemMap.get(item.id)?.installCount}
                                                        onGet={() => m.handleGet(item.id)}
                                                        onRemove={() => { const own = m.inventoryMap.get(item.id); if (own) m.handleRemove(own); }}
                                                        onSubscribe={() => m.setSubscribeTarget(item)}
                                                        onCancelSub={() => { const sub = m.subscriptionMap.get(subKey); if (sub) m.handleCancelSubscription(sub); }}
                                                        onRate={() => {
                                                            const cId = item.id.startsWith("community-") ? item.id.slice(10) : item.id;
                                                            m.setRatingDialogItem({ id: cId, type: "community", name: item.name });
                                                        }}
                                                        busy={m.busyId === item.id}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </section>
                                );
                            })}
                        </>
                    )}
                </div>
            )}

            {/* ─── Category View ─── */}
            {m.filters.category && !m.isGlobalSearch && (
                <div className="space-y-6">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => m.setFilters({ category: null, subCategory: "All", search: "" })}
                            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <ArrowLeft className="h-4 w-4" /> Marketplace
                        </button>
                        <span className="text-muted-foreground/30">/</span>
                        <h2 className="text-lg font-semibold">{categoryLabel}</h2>
                    </div>

                    {/* Agents */}
                    {m.filters.category === "agents" && (
                        <div className="space-y-8">
                            <MarketSearch
                                search={m.filters.search}
                                onSearchChange={(v) => m.setFilters({ search: v })}
                                sortBy={m.filters.sort}
                                onSortChange={(v) => m.setFilters({ sort: v })}
                                sourceFilter={m.filters.source}
                                onSourceChange={(v) => m.setFilters({ source: v })}
                                placeholder="Search personas..."
                                accentColor="purple"
                            />
                            <MarketSubCategories
                                categories={m.subCategories}
                                activeCategory={m.filters.subCategory}
                                onSelect={(v) => m.setFilters({ subCategory: v })}
                                accentColor="purple"
                            />
                            {m.filteredPersonas.length > 0 ? (
                                <div>
                                    <p className="text-sm text-muted-foreground mb-4">
                                        Showing <span className="text-foreground font-medium">{m.filteredPersonas.length}</span> personas
                                    </p>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
                                        {m.filteredPersonas.map((persona) => (
                                            <PersonaCard key={persona.id} persona={persona} onSelect={m.setSelectedPersona} />
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className="text-center py-12 text-muted-foreground">
                                    <Store className="h-8 w-8 mx-auto mb-3 opacity-30" />
                                    <p>No personas match your search</p>
                                </div>
                            )}

                            {m.orgAgents.length > 0 && (
                                <div className="space-y-4 pt-4 border-t border-border">
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-lg font-semibold">Your Agents</h2>
                                        <Badge variant="outline" className="text-xs">{m.orgAgents.length}</Badge>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                                        {m.orgAgents.map((agent) => (
                                            <AgentMarketCard key={agent.id} agent={agent} />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Bundles */}
                    {m.filters.category === "bundles" && (
                        <MarketBundles
                            allItems={m.allItems}
                            inventoryMap={m.inventoryMap}
                            busyId={m.busyId}
                            onGetBundle={m.handleGetBundle}
                        />
                    )}

                    {/* Inventory */}
                    {m.filters.category === "inventory" && (
                        <MarketInventory
                            allItems={m.allItems}
                            inventory={m.inventory}
                            inventoryMap={m.inventoryMap}
                            subscriptionMap={m.subscriptionMap}
                            communityItemMap={m.communityItemMap}
                            busyId={m.busyId}
                            onGet={m.handleGet}
                            onRemove={m.handleRemove}
                            onSubscribe={m.setSubscribeTarget}
                            onCancelSub={m.handleCancelSubscription}
                            onRate={(id, name) => m.setRatingDialogItem({ id, type: "community", name })}
                            onBrowse={() => m.setFilters({ category: null })}
                        />
                    )}

                    {/* Submissions */}
                    {m.filters.category === "submit" && (
                        <MarketSubmissions
                            submissions={m.userSubmissions}
                            walletAddress={m.userAddress}
                            orgId={m.currentOrg?.id}
                            deletingId={m.deletingId}
                            onDelete={m.handleDeleteSubmission}
                            onSubmitted={() => { m.loadUserSubmissions(); m.loadCommunityItems(); }}
                        />
                    )}

                    {/* Standard item views */}
                    {m.filters.category && !["agents", "bundles", "inventory", "submit"].includes(m.filters.category) && (
                        <>
                            <MarketSearch
                                search={m.filters.search}
                                onSearchChange={(v) => m.setFilters({ search: v })}
                                sortBy={m.filters.sort}
                                onSortChange={(v) => m.setFilters({ sort: v })}
                                sourceFilter={m.filters.source}
                                onSourceChange={(v) => m.setFilters({ source: v })}
                                placeholder={`Search ${categoryLabel.toLowerCase()}...`}
                                accentColor={m.accentColor}
                            />
                            <MarketSubCategories
                                categories={m.subCategories}
                                activeCategory={m.filters.subCategory}
                                onSelect={(v) => m.setFilters({ subCategory: v })}
                                accentColor={m.accentColor}
                            />
                            <MarketGrid
                                loading={m.loading}
                                resultCount={m.filteredItems.length}
                                resultLabel={categoryLabel.toLowerCase()}
                                searchQuery={m.filters.search || undefined}
                            >
                                {m.filteredItems.map((item) => {
                                    const subKey = item.id.startsWith("community-") ? item.id.slice(10) : item.id;
                                    return (
                                        <MarketItemCard
                                            key={item.id}
                                            item={item}
                                            owned={m.inventoryMap.get(item.id)}
                                            subscription={m.subscriptionMap.get(subKey)}
                                            avgRating={m.communityItemMap.get(item.id)?.avgRating}
                                            ratingCount={m.communityItemMap.get(item.id)?.ratingCount}
                                            installCount={m.communityItemMap.get(item.id)?.installCount}
                                            onGet={() => m.handleGet(item.id)}
                                            onRemove={() => { const own = m.inventoryMap.get(item.id); if (own) m.handleRemove(own); }}
                                            onSubscribe={() => m.setSubscribeTarget(item)}
                                            onCancelSub={() => { const sub = m.subscriptionMap.get(subKey); if (sub) m.handleCancelSubscription(sub); }}
                                            onRate={() => {
                                                const cId = item.id.startsWith("community-") ? item.id.slice(10) : item.id;
                                                m.setRatingDialogItem({ id: cId, type: "community", name: item.name });
                                            }}
                                            busy={m.busyId === item.id}
                                        />
                                    );
                                })}
                            </MarketGrid>
                        </>
                    )}
                </div>
            )}

            {/* ─── Dialogs ─── */}
            <SubscribeDialog
                open={!!m.subscribeTarget}
                onOpenChange={(open) => { if (!open) m.setSubscribeTarget(null); }}
                item={m.subscribeTarget}
                busyId={m.busyId}
                onSubscribe={m.handleSubscribe}
            />

            <PersonaDetailDialog
                open={!!m.selectedPersona}
                onOpenChange={(open) => { if (!open) m.setSelectedPersona(null); }}
                persona={m.selectedPersona}
                onApply={(p) => { m.setSelectedPersona(null); m.setApplyPersona(p); }}
            />

            <ApplyPersonaDialog
                open={!!m.applyPersona}
                onOpenChange={(open) => { if (!open) m.setApplyPersona(null); }}
                persona={m.applyPersona}
                orgId={m.currentOrg?.id || ""}
                installerAddress={m.userAddress}
                onApplied={() => { m.setApplyPersona(null); m.loadOrgAgents(); m.loadAgentInstalls(); }}
            />

            {m.cryptoCheckout && m.currentOrg && (
                <CryptoCheckoutDialog
                    open={!!m.cryptoCheckout}
                    onOpenChange={(open) => { if (!open) m.setCryptoCheckout(null); }}
                    itemId={m.cryptoCheckout.itemId}
                    itemName={m.cryptoCheckout.itemName}
                    itemIcon={m.cryptoCheckout.itemIcon}
                    plan={m.cryptoCheckout.plan}
                    orgId={m.currentOrg.id}
                    walletAddress={m.userAddress}
                    priceUsd={m.cryptoCheckout.priceUsd}
                    currency={m.cryptoCheckout.currency}
                    onSuccess={() => { m.setCryptoCheckout(null); m.loadSubscriptions(); }}
                />
            )}

            <RatingDialog
                open={!!m.ratingDialogItem}
                onOpenChange={(open) => { if (!open) m.setRatingDialogItem(null); }}
                itemName={m.ratingDialogItem?.name || ""}
                onSubmit={m.handleRateSubmit}
            />
        </div>
    );
}

function MarketSkeleton() {
    return (
        <div className="w-full px-4 sm:px-6 py-6">
            <div className="h-48 rounded-2xl bg-muted/20 animate-pulse mb-8" />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {Array.from({ length: 8 }, (_, i) => (
                    <div key={i} className="h-32 rounded-xl bg-muted/20 animate-pulse" />
                ))}
            </div>
        </div>
    );
}

export default function MarketPage() {
    return (
        <Suspense fallback={<MarketSkeleton />}>
            <MarketPageInner />
        </Suspense>
    );
}
