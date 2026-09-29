"use client";

interface MarketSubCategoriesProps {
    categories: string[];
    activeCategory: string;
    onSelect: (category: string) => void;
    accentColor?: "amber" | "purple" | "blue" | "cyan" | "pink" | "emerald";
}

const ACCENT_STYLES: Record<string, string> = {
    amber: "bg-amber-500/20 text-amber-400 border border-amber-500/30",
    purple: "bg-purple-500/20 text-purple-400 border border-purple-500/30",
    blue: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
    cyan: "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30",
    pink: "bg-pink-500/20 text-pink-400 border border-pink-500/30",
    emerald: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
};

export function MarketSubCategories({
    categories, activeCategory, onSelect, accentColor = "amber",
}: MarketSubCategoriesProps) {
    if (categories.length <= 1) return null;

    const activeClass = ACCENT_STYLES[accentColor] || ACCENT_STYLES.amber;

    return (
        <div className="flex items-center gap-1.5 overflow-x-auto mb-6 scrollbar-none">
            {categories.map((cat) => (
                <button
                    key={cat}
                    onClick={() => onSelect(cat)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${activeCategory === cat
                        ? activeClass
                        : "bg-muted/50 text-muted-foreground hover:bg-muted border border-transparent"
                    }`}
                >
                    {cat}
                </button>
            ))}
        </div>
    );
}
