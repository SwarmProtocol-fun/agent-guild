"use client";

import React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Star, Download, DollarSign, User, ChevronRight, ShieldCheck, Users } from "lucide-react";
import type { AgentPackage } from "@/lib/skills";

interface PersonaCardProps {
    persona: AgentPackage;
    onSelect: (persona: AgentPackage) => void;
}

export const PersonaCard = React.memo(function PersonaCard({ persona, onSelect }: PersonaCardProps) {
    const price = persona.pricing.configPurchase;
    const isFree = !price || price === 0;
    const isVerified = persona.source === "verified";

    return (
        <Card
            className={`p-0 bg-card border-border transition-all hover:border-purple-500/30 hover:shadow-lg hover:shadow-purple-500/5 cursor-pointer group overflow-hidden min-h-[280px] flex flex-col ${isVerified ? "ring-1 ring-purple-500/10" : ""}`}
            onClick={() => onSelect(persona)}
        >
            {/* Banner */}
            <div className="h-24 bg-gradient-to-br from-purple-500/10 via-purple-500/5 to-cyan-500/10 flex items-center justify-center relative shrink-0">
                <span className="text-4xl group-hover:scale-110 transition-transform">{persona.icon}</span>
                <div className="absolute top-2 right-2 flex items-center gap-1">
                    {isVerified ? (
                        <Badge variant="outline" className="text-[10px] border-amber-500/20 text-amber-500 bg-card/80 backdrop-blur-sm">
                            <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />Official
                        </Badge>
                    ) : (
                        <Badge variant="outline" className="text-[10px] border-blue-500/20 text-blue-400 bg-card/80 backdrop-blur-sm">
                            <Users className="h-2.5 w-2.5 mr-0.5" />Community
                        </Badge>
                    )}
                    {isFree ? (
                        <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs font-bold">
                            Free
                        </Badge>
                    ) : (
                        <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs font-bold">
                            <DollarSign className="h-3 w-3 mr-0.5" />{price}
                        </Badge>
                    )}
                </div>
                <ChevronRight className="absolute top-2 left-2 h-4 w-4 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>

            <div className="p-4 space-y-3 flex-1 flex flex-col">
                {/* Name + archetype */}
                <div>
                    <h3 className="font-bold text-base">{persona.name}</h3>
                    <p className="text-xs text-purple-400">{persona.identity.agentType}</p>
                </div>

                {/* Short bio */}
                <p className="text-xs text-muted-foreground line-clamp-2">{persona.description}</p>

                {/* Personality trait chips */}
                <div className="flex flex-wrap gap-1">
                    {(persona.identity.personality || []).slice(0, 4).map((trait) => (
                        <span
                            key={trait}
                            className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20"
                        >
                            {trait}
                        </span>
                    ))}
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Stats row */}
                <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-2 border-t border-border">
                    <span className="flex items-center gap-1">
                        <Download className="h-2.5 w-2.5" />
                        {persona.installCount} installs
                    </span>
                    {persona.avgRating > 0 && (
                        <span className="flex items-center gap-0.5">
                            <Star className="h-2.5 w-2.5 text-amber-400 fill-amber-400" />
                            {persona.avgRating.toFixed(1)}
                            <span className="text-muted-foreground/50">({persona.ratingCount})</span>
                        </span>
                    )}
                    <span className="flex items-center gap-1">
                        <User className="h-2.5 w-2.5" />
                        {persona.author}
                    </span>
                </div>

                {/* Action */}
                <Button
                    size="sm"
                    className="w-full h-8 text-xs bg-purple-600 hover:bg-purple-700 text-white gap-1"
                    onClick={(e) => { e.stopPropagation(); onSelect(persona); }}
                >
                    {isFree ? "Get Config" : `Buy — $${price}`}
                </Button>
            </div>
        </Card>
    );
});
