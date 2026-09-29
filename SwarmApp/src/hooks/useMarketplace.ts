"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import { useSession } from "@/contexts/SessionContext";
import {
    type Skill,
    type OwnedItem,
    type MarketItemType,
    type CommunityMarketItem,
    type MarketSubscription,
    type SubscriptionPlan,
    type AgentInstall,
    type AgentPackage,
    SKILL_REGISTRY,
    SKILL_BUNDLES,
    MOD_CATEGORIES,
    PLUGIN_CATEGORIES,
    SKILL_ONLY_CATEGORIES,
    SKIN_CATEGORIES,
    AGENT_ITEM_CATEGORIES,
    COMPUTE_CATEGORIES,
    acquireItem,
    removeFromInventory,
    getOwnedItems,
    acquireBundle,
    getCommunityItems,
    getUserSubmissions,
    getOrgSubscriptions,
    subscribeToItem,
    cancelSubscription,
    getAgentInstalls,
    getFeaturedItems,
    getMarketplaceAgents,
} from "@/lib/skills";
import { computeRankingScore } from "@/lib/submission-scoring";
const trackMarketplaceEvent = (..._args: unknown[]) => {}; // posthog removed
import { type Agent, getAgentsByOrg } from "@/lib/firestore";
import { PERSONA_REGISTRY, PERSONA_CATEGORIES } from "@/lib/personas";
import type { MarketView, MarketCategory, SortOption, SourceFilter, MarketFilters } from "@/lib/market/types";

// ── Category mapping ──

const CATEGORIES_BY_TYPE: Record<MarketItemType, string[]> = {
    mod: MOD_CATEGORIES,
    plugin: PLUGIN_CATEGORIES,
    skill: SKILL_ONLY_CATEGORIES,
    skin: SKIN_CATEGORIES,
    agent: AGENT_ITEM_CATEGORIES,
    compute: COMPUTE_CATEGORIES,
};

const TYPE_FOR_CATEGORY: Record<MarketCategory, MarketItemType | undefined> = {
    agents: "agent",
    mods: "mod",
    plugins: "plugin",
    skills: "skill",
    skins: "skin",
    compute: "compute",
    bundles: undefined,
};

export function useMarketplace() {
    const { currentOrg } = useOrg();
    const account = useWalletAccount();
    const { address: sessionAddress, authenticated } = useSession();
    const userAddress = account?.address || sessionAddress || "";

    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();

    // ── URL-driven filter state ──

    const initialView = searchParams.get("category") as MarketView | null;
    const initialSearch = searchParams.get("q") || "";
    const initialSort = (searchParams.get("sort") as SortOption) || "name";
    const initialSource = (searchParams.get("source") as SourceFilter) || "all";
    const initialSubCategory = searchParams.get("sub") || "All";

    const [filters, setFiltersState] = useState<MarketFilters>({
        search: initialSearch,
        category: initialView,
        subCategory: initialSubCategory,
        sort: initialSort,
        source: initialSource,
    });

    const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(filters.search);
            if (filters.search) trackMarketplaceEvent("search", { query: filters.search });
        }, 300);
        return () => clearTimeout(timer);
    }, [filters.search]);

    // Update URL when filters change
    const setFilters = useCallback((partial: Partial<MarketFilters>) => {
        setFiltersState((prev) => {
            const next = { ...prev, ...partial };
            // Build URL params
            const params = new URLSearchParams();
            if (next.category) params.set("category", next.category);
            if (next.search) params.set("q", next.search);
            if (next.sort && next.sort !== "name") params.set("sort", next.sort);
            if (next.source && next.source !== "all") params.set("source", next.source);
            if (next.subCategory && next.subCategory !== "All") params.set("sub", next.subCategory);
            const paramStr = params.toString();
            router.replace(`${pathname}${paramStr ? `?${paramStr}` : ""}`, { scroll: false });
            return next;
        });
    }, [pathname, router]);

    const isDiscoveryHome = !filters.category && !filters.search;
    const isGlobalSearch = !!filters.search && !filters.category;

    // ── Data state ──

    const [inventory, setInventory] = useState<OwnedItem[]>([]);
    const [communityItems, setCommunityItems] = useState<CommunityMarketItem[]>([]);
    const [userSubmissions, setUserSubmissions] = useState<CommunityMarketItem[]>([]);
    const [subscriptions, setSubscriptions] = useState<MarketSubscription[]>([]);
    const [orgAgents, setOrgAgents] = useState<Agent[]>([]);
    const [agentInstalls, setAgentInstalls] = useState<AgentInstall[]>([]);
    const [marketplaceAgents, setMarketplaceAgents] = useState<AgentPackage[]>([]);
    const [featuredCommunity, setFeaturedCommunity] = useState<CommunityMarketItem[]>([]);
    const [featuredAgents, setFeaturedAgents] = useState<AgentPackage[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    // Dialog triggers
    const [subscribeTarget, setSubscribeTarget] = useState<Skill | null>(null);
    const [selectedPersona, setSelectedPersona] = useState<AgentPackage | null>(null);
    const [applyPersona, setApplyPersona] = useState<AgentPackage | null>(null);
    const [ratingDialogItem, setRatingDialogItem] = useState<{ id: string; type: "agent" | "community"; name: string } | null>(null);
    const [cryptoCheckout, setCryptoCheckout] = useState<{
        itemId: string; itemName: string; itemIcon: string;
        plan: SubscriptionPlan; priceUsd: number; currency: string;
    } | null>(null);

    // ── Data loading ──

    const loadInventory = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoading(true);
            const data = await getOwnedItems(currentOrg.id);
            setInventory(data);
        } catch (err) {
            console.error("Failed to load inventory:", err);
        } finally {
            setLoading(false);
        }
    }, [currentOrg]);

    const loadCommunityItems = useCallback(async () => {
        try {
            const items = await getCommunityItems();
            setCommunityItems(items);
        } catch (err) {
            console.error("Failed to load community items:", err);
        }
    }, []);

    const loadFeatured = useCallback(async () => {
        try {
            const { communityItems: fc, agents: fa } = await getFeaturedItems();
            setFeaturedCommunity(fc);
            setFeaturedAgents(fa);
        } catch {
            // silent
        }
    }, []);

    const loadUserSubmissions = useCallback(async () => {
        if (!account) return;
        try {
            const subs = await getUserSubmissions(userAddress);
            setUserSubmissions(subs);
        } catch (err) {
            console.error("Failed to load submissions:", err);
        }
    }, [account, userAddress]);

    const loadSubscriptions = useCallback(async () => {
        if (!currentOrg) return;
        try {
            const subs = await getOrgSubscriptions(currentOrg.id);
            setSubscriptions(subs);
        } catch (err) {
            console.error("Failed to load subscriptions:", err);
        }
    }, [currentOrg]);

    const loadOrgAgents = useCallback(async () => {
        if (!currentOrg) return;
        try {
            const agents = await getAgentsByOrg(currentOrg.id);
            setOrgAgents(agents);
        } catch (err) {
            console.error("Failed to load org agents:", err);
        }
    }, [currentOrg]);

    const loadAgentInstalls = useCallback(async () => {
        if (!currentOrg) return;
        try {
            const installs = await getAgentInstalls(currentOrg.id);
            setAgentInstalls(installs.filter((i) => i.status === "active"));
        } catch (err) {
            console.error("Failed to load agent installs:", err);
        }
    }, [currentOrg]);

    const loadMarketplaceAgents = useCallback(async () => {
        try {
            const agents = await getMarketplaceAgents();
            setMarketplaceAgents(agents);
        } catch (err) {
            console.error("Failed to load marketplace agents:", err);
        }
    }, []);

    useEffect(() => { loadInventory(); }, [loadInventory]);
    useEffect(() => { loadCommunityItems(); }, [loadCommunityItems]);
    useEffect(() => { loadUserSubmissions(); }, [loadUserSubmissions]);
    useEffect(() => { loadSubscriptions(); }, [loadSubscriptions]);
    useEffect(() => { loadOrgAgents(); }, [loadOrgAgents]);
    useEffect(() => { loadAgentInstalls(); }, [loadAgentInstalls]);
    useEffect(() => { loadMarketplaceAgents(); }, [loadMarketplaceAgents]);
    useEffect(() => { loadFeatured(); }, [loadFeatured]);

    // Handle return from Stripe checkout — add mod to inventory so sidebar picks it up
    useEffect(() => {
        const status = searchParams.get("checkout");
        const modId = searchParams.get("mod");
        if (status !== "success" || !modId || !currentOrg || !userAddress) return;
        (async () => {
            try {
                const owned = await getOwnedItems(currentOrg.id);
                if (!owned.some(o => o.skillId === modId)) {
                    await acquireItem(currentOrg.id, modId, userAddress);
                    await loadInventory();
                    window.dispatchEvent(new Event("swarm-inventory-changed"));
                }
            } catch (e) {
                console.error("Failed to add mod to inventory after checkout:", e);
            }
        })();
    }, [searchParams, currentOrg, userAddress, loadInventory]);

    // ── Merged data ──

    const allItems: Skill[] = useMemo(() => {
        const communitySkills: Skill[] = communityItems.map((c) => ({
            id: `community-${c.id}`,
            name: c.name,
            description: c.description,
            type: c.type,
            source: "community" as const,
            category: c.category,
            icon: c.icon,
            version: c.version,
            author: c.submittedByName || c.submittedBy.slice(0, 8) + "...",
            requiredKeys: c.requiredKeys,
            tags: c.tags,
            pricing: c.pricing,
        }));
        return [...SKILL_REGISTRY, ...communitySkills];
    }, [communityItems]);

    const communityItemMap = useMemo(() => {
        const map = new Map<string, CommunityMarketItem>();
        for (const c of communityItems) {
            map.set(`community-${c.id}`, c);
            map.set(c.id, c);
        }
        return map;
    }, [communityItems]);

    const inventoryMap = useMemo(() => new Map(inventory.map((i) => [i.skillId, i])), [inventory]);
    const subscriptionMap = useMemo(() => new Map(subscriptions.map((s) => [s.itemId, s])), [subscriptions]);

    // ── Personas ──

    const allPersonas = useMemo(() => {
        return [...PERSONA_REGISTRY, ...marketplaceAgents];
    }, [marketplaceAgents]);

    // ── Filtering ──

    const filterItems = useCallback((items: Skill[], type?: MarketItemType) => {
        let result = items;

        if (type) {
            result = result.filter((s) => s.type === type);
        }

        if (debouncedSearch) {
            const q = debouncedSearch.toLowerCase();
            result = result.filter((s) =>
                s.name.toLowerCase().includes(q) ||
                s.description.toLowerCase().includes(q) ||
                s.tags.some((t) => t.toLowerCase().includes(q))
            );
        }

        if (filters.subCategory !== "All") {
            result = result.filter((s) => s.category === filters.subCategory);
        }

        if (filters.source !== "all") {
            result = result.filter((s) => s.source === filters.source);
        }

        // Sort
        result = [...result].sort((a, b) => {
            if (filters.sort === "name") return a.name.localeCompare(b.name);
            if (filters.sort === "type") return a.type.localeCompare(b.type);
            if (filters.sort === "rating") {
                const aR = communityItemMap.get(a.id)?.avgRating ?? 0;
                const bR = communityItemMap.get(b.id)?.avgRating ?? 0;
                return bR - aR;
            }
            if (filters.sort === "installs") {
                const aI = communityItemMap.get(a.id)?.installCount ?? 0;
                const bI = communityItemMap.get(b.id)?.installCount ?? 0;
                return bI - aI;
            }
            if (filters.sort === "trending") {
                const score = (id: string) => {
                    const c = communityItemMap.get(id);
                    if (!c) return 0;
                    return computeRankingScore({
                        installCount: c.installCount ?? 0,
                        avgRating: c.avgRating ?? 0,
                        ratingCount: c.ratingCount ?? 0,
                        publishedAt: c.submittedAt,
                        publisherTier: 0,
                    });
                };
                return score(b.id) - score(a.id);
            }
            return 0;
        });

        return result;
    }, [debouncedSearch, filters.subCategory, filters.source, filters.sort, communityItemMap]);

    // Items for the active category view
    const filteredItems = useMemo(() => {
        const type = filters.category ? TYPE_FOR_CATEGORY[filters.category as MarketCategory] : undefined;
        if (filters.category === "inventory") {
            return filterItems(allItems.filter((s) => inventoryMap.has(s.id)));
        }
        return filterItems(allItems, type);
    }, [allItems, filters.category, filterItems, inventoryMap]);

    // Personas for the agents view
    const filteredPersonas = useMemo(() => {
        let items = allPersonas;
        if (debouncedSearch) {
            const q = debouncedSearch.toLowerCase();
            items = items.filter((p) =>
                p.name.toLowerCase().includes(q) ||
                p.description.toLowerCase().includes(q) ||
                p.tags.some((t) => t.toLowerCase().includes(q)) ||
                (p.identity.personality || []).some((t) => t.toLowerCase().includes(q))
            );
        }
        if (filters.subCategory !== "All") {
            items = items.filter((p) => {
                const catLabel = p.category.charAt(0).toUpperCase() + p.category.slice(1);
                return catLabel === filters.subCategory;
            });
        }
        if (filters.source !== "all") {
            items = items.filter((p) => p.source === filters.source);
        }
        return items;
    }, [allPersonas, debouncedSearch, filters.subCategory, filters.source]);

    // Global search results (grouped by type)
    const globalSearchResults = useMemo(() => {
        if (!isGlobalSearch || !debouncedSearch) return null;
        const q = debouncedSearch.toLowerCase();
        const matchItem = (s: Skill) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.tags.some((t) => t.toLowerCase().includes(q));
        const matchPersona = (p: AgentPackage) =>
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.tags.some((t) => t.toLowerCase().includes(q)) ||
            (p.identity.personality || []).some((t) => t.toLowerCase().includes(q));

        const agents = allPersonas.filter(matchPersona);
        const mods = allItems.filter((s) => s.type === "mod" && matchItem(s));
        const plugins = allItems.filter((s) => s.type === "plugin" && matchItem(s));
        const skills = allItems.filter((s) => s.type === "skill" && matchItem(s));
        const skins = allItems.filter((s) => s.type === "skin" && matchItem(s));
        const compute = allItems.filter((s) => s.type === "compute" && matchItem(s));

        return {
            agents,
            mods,
            plugins,
            skills,
            skins,
            compute,
            totalCount: agents.length + mods.length + plugins.length + skills.length + skins.length + compute.length,
        };
    }, [isGlobalSearch, debouncedSearch, allItems, allPersonas]);

    // Sub-categories for active type
    const subCategories = useMemo(() => {
        const cat = filters.category as MarketCategory;
        if (!cat || cat === "bundles") return ["All"];
        if (cat === "agents") return PERSONA_CATEGORIES;
        const type = TYPE_FOR_CATEGORY[cat];
        if (!type) return ["All"];
        const staticCats = CATEGORIES_BY_TYPE[type] || [];
        const communityCats = allItems
            .filter((s) => s.type === type && s.source === "community")
            .map((s) => s.category);
        const merged = new Set([...staticCats, ...communityCats]);
        return ["All", ...Array.from(merged).filter((c) => c !== "All").sort()];
    }, [filters.category, allItems]);

    // Category counts
    const categoryCounts = useMemo(() => ({
        agents: allPersonas.length,
        mods: allItems.filter((s) => s.type === "mod").length,
        plugins: allItems.filter((s) => s.type === "plugin").length,
        skills: allItems.filter((s) => s.type === "skill").length,
        skins: allItems.filter((s) => s.type === "skin").length,
        compute: allItems.filter((s) => s.type === "compute").length,
        bundles: SKILL_BUNDLES.length,
    }), [allItems, allPersonas]);

    // ── Handlers ──

    const handleGet = useCallback(async (skillId: string) => {
        if (!currentOrg || (!account && !authenticated)) return;
        setBusyId(skillId);
        try {
            const skill = SKILL_REGISTRY.find((s) => s.id === skillId);
            if (skill?.requires?.length) {
                const missing = skill.requires.filter((dep) => !inventoryMap.has(dep));
                for (const dep of missing) {
                    await acquireItem(currentOrg.id, dep, userAddress);
                }
            }
            await acquireItem(currentOrg.id, skillId, userAddress);
            trackMarketplaceEvent("item_installed", { skillId, type: skill?.type });
            await loadInventory();
            window.dispatchEvent(new Event("swarm-inventory-changed"));
        } finally {
            setBusyId(null);
        }
    }, [currentOrg, account, authenticated, userAddress, inventoryMap, loadInventory]);

    const handleRemove = useCallback(async (item: OwnedItem) => {
        const dependents = SKILL_REGISTRY.filter(
            (s) => s.requires?.includes(item.skillId) && inventoryMap.has(s.id)
        );
        setBusyId(item.skillId);
        try {
            for (const dep of dependents) {
                const depOwned = inventoryMap.get(dep.id);
                if (depOwned) await removeFromInventory(depOwned.id);
            }
            await removeFromInventory(item.id);
            trackMarketplaceEvent("item_removed", { skillId: item.skillId });
            await loadInventory();
            window.dispatchEvent(new Event("swarm-inventory-changed"));
        } finally {
            setBusyId(null);
        }
    }, [inventoryMap, loadInventory]);

    const handleGetBundle = useCallback(async (bundleId: string) => {
        if (!currentOrg || !account) return;
        setBusyId(bundleId);
        try {
            await acquireBundle(
                currentOrg.id,
                bundleId,
                userAddress,
                inventory.map((i) => i.skillId),
            );
            await loadInventory();
            window.dispatchEvent(new Event("swarm-inventory-changed"));
        } finally {
            setBusyId(null);
        }
    }, [currentOrg, account, userAddress, inventory, loadInventory]);

    const handleSubscribe = useCallback(async (itemId: string, plan: SubscriptionPlan, paymentMethod: "stripe" | "crypto" = "stripe") => {
        if (!currentOrg || (!account && !authenticated)) return;
        trackMarketplaceEvent("checkout_started", { itemId, plan, paymentMethod });
        setBusyId(itemId);
        try {
            if (paymentMethod === "stripe") {
                const res = await fetch("/api/v1/marketplace/checkout", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-wallet-address": userAddress,
                    },
                    body: JSON.stringify({ modId: itemId, plan, orgId: currentOrg.id }),
                });
                const data = await res.json();
                if (data.url) {
                    window.location.href = data.url;
                    return;
                }
                if (data.error?.includes("not configured")) {
                    await subscribeToItem(currentOrg.id, itemId, plan, userAddress);
                    // Also add to inventory so the sidebar picks it up
                    if (!inventoryMap.has(itemId)) {
                        await acquireItem(currentOrg.id, itemId, userAddress);
                    }
                    await loadSubscriptions();
                    await loadInventory();
                    window.dispatchEvent(new Event("swarm-inventory-changed"));
                    setSubscribeTarget(null);
                }
            } else {
                const targetItem = allItems.find((s) => s.id === itemId || s.id === `community-${itemId}`);
                const tier = targetItem?.pricing?.tiers?.find((t) => t.plan === plan);
                setCryptoCheckout({
                    itemId,
                    itemName: targetItem?.name || itemId,
                    itemIcon: targetItem?.icon || "",
                    plan,
                    priceUsd: tier?.price || 0,
                    currency: tier?.currency || "USD",
                });
            }
        } finally {
            setBusyId(null);
        }
    }, [currentOrg, account, authenticated, userAddress, allItems, inventoryMap, loadSubscriptions, loadInventory]);

    const handleCancelSubscription = useCallback(async (sub: MarketSubscription) => {
        setBusyId(sub.itemId);
        try {
            await cancelSubscription(sub.id);
            await loadSubscriptions();
        } finally {
            setBusyId(null);
        }
    }, [loadSubscriptions]);

    const handleDeleteSubmission = useCallback(async (docId: string) => {
        setDeletingId(docId);
        try {
            const res = await fetch(`/api/v1/marketplace/items/${docId}`, {
                method: "DELETE",
                headers: { "x-wallet-address": userAddress },
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                console.error("Delete failed:", data.error);
            }
            trackMarketplaceEvent("submission_deleted", { itemId: docId });
            await loadUserSubmissions();
            await loadCommunityItems();
        } finally {
            setDeletingId(null);
        }
    }, [userAddress, loadUserSubmissions, loadCommunityItems]);

    const handleRateSubmit = useCallback(async (rating: number, review: string) => {
        if (!ratingDialogItem || !currentOrg) return;
        await fetch("/api/v1/marketplace/rate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-wallet-address": userAddress,
            },
            body: JSON.stringify({
                itemId: ratingDialogItem.id,
                itemType: ratingDialogItem.type,
                rating,
                review,
                orgId: currentOrg.id,
            }),
        });
        trackMarketplaceEvent("rating_submitted", { itemId: ratingDialogItem.id, itemType: ratingDialogItem.type, rating });
        setRatingDialogItem(null);
        loadCommunityItems();
        loadMarketplaceAgents();
    }, [ratingDialogItem, currentOrg, userAddress, loadCommunityItems, loadMarketplaceAgents]);

    // Accent color per category
    const accentColor = useMemo(() => {
        switch (filters.category) {
            case "agents": return "purple" as const;
            case "mods": return "amber" as const;
            case "plugins": return "blue" as const;
            case "skills": return "cyan" as const;
            case "skins": return "pink" as const;
            case "compute": return "emerald" as const;
            default: return "amber" as const;
        }
    }, [filters.category]);

    return {
        // Auth
        isAuthenticated: !!account || authenticated,
        userAddress,

        // Filters & navigation
        filters,
        setFilters,
        isDiscoveryHome,
        isGlobalSearch,
        accentColor,

        // Data
        allItems,
        filteredItems,
        allPersonas,
        filteredPersonas,
        globalSearchResults,
        inventory,
        subscriptions,
        userSubmissions,
        featuredCommunity,
        featuredAgents,
        orgAgents,
        agentInstalls,
        categoryCounts,
        subCategories,

        // Lookup maps
        inventoryMap,
        subscriptionMap,
        communityItemMap,

        // Handlers
        handleGet,
        handleRemove,
        handleGetBundle,
        handleSubscribe,
        handleCancelSubscription,
        handleDeleteSubmission,
        handleRateSubmit,

        // UI state
        busyId,
        loading,
        deletingId,

        // Dialog state
        subscribeTarget,
        setSubscribeTarget,
        selectedPersona,
        setSelectedPersona,
        applyPersona,
        setApplyPersona,
        ratingDialogItem,
        setRatingDialogItem,
        cryptoCheckout,
        setCryptoCheckout,

        // Reload triggers
        loadOrgAgents,
        loadAgentInstalls,
        loadSubscriptions,
        loadUserSubmissions,
        loadCommunityItems,

        // Org
        currentOrg,
    };
}
