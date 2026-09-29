/**
 * Market — Shared types for the marketplace redesign.
 */

export type {
    Skill,
    OwnedItem,
    MarketItemType,
    MarketItemSource,
    CommunityMarketItem,
    MarketSubscription,
    SubscriptionPlan,
    AgentPackage,
    AgentInstall,
    AgentDistribution,
    MarketPricing,
    PricingTier,
} from "@/lib/skills";

export type MarketCategory =
    | "agents"
    | "mods"
    | "plugins"
    | "skills"
    | "skins"
    | "compute"
    | "bundles";

export type MarketView = MarketCategory | "inventory" | "submit";

export type SortOption = "name" | "type" | "rating" | "installs" | "trending";
export type SourceFilter = "all" | "verified" | "community";

export interface MarketFilters {
    search: string;
    category: MarketView | null;
    subCategory: string;
    sort: SortOption;
    source: SourceFilter;
}

export interface CategoryCardConfig {
    key: MarketCategory;
    label: string;
    description: string;
    gradient: string;
    borderColor: string;
    iconColor: string;
    count: number;
}
