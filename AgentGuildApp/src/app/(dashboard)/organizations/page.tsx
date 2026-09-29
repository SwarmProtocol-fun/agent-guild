/** Organizations Directory — Your orgs + public directory of organizations on Agent Guild. */
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { Search, Building2, Users } from "lucide-react";
import { Organization, getPublicOrganizations, createChannel, getChannelsByOrg } from "@/lib/firestore";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";

export default function OrganizationsPage() {
    const router = useRouter();
    const { currentOrg, organizations: myOrgs } = useOrg();
    const account = useWalletAccount();
    const [orgs, setOrgs] = useState<Organization[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [openingChannel, setOpeningChannel] = useState<string | null>(null);

    useEffect(() => {
        async function load() {
            try {
                const data = await getPublicOrganizations();
                setOrgs(data);
            } catch (err) {
                console.error("Failed to load organizations:", err);
            } finally {
                setLoading(false);
            }
        }
        load();
    }, []);

    const handleStartChannel = async (e: React.MouseEvent, targetOrg: Organization) => {
        e.stopPropagation();
        if (!currentOrg) return;
        setOpeningChannel(targetOrg.id);

        try {
            const channels = await getChannelsByOrg(currentOrg.id);
            const channelName = `Chat w/ ${targetOrg.name}`;

            let chatChannel = channels.find(c => c.name === channelName);

            if (!chatChannel) {
                const id = await createChannel({
                    orgId: currentOrg.id,
                    name: channelName,
                    createdAt: new Date(),
                });
                chatChannel = { id, orgId: currentOrg.id, name: channelName, createdAt: new Date() };
            }

            router.push(`/chat?channel=${chatChannel.id}`);
        } catch (err) {
            console.error("Failed to start channel", err);
        } finally {
            setOpeningChannel(null);
        }
    };

    const filteredOrgs = orgs.filter(o =>
        o.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (o.description || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Organizations</h1>
                    <p className="text-muted-foreground mt-1">
                        Browse and connect with organizations on Agent Guild.
                    </p>
                </div>
                <div className="relative w-full md:w-80">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search organizations..."
                        className="pl-9 bg-background/50 border-white/10"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
            </div>

            {/* ── Your Organizations ── */}
            {myOrgs.length > 0 && (
                <div>
                    <h2 className="text-lg font-semibold mb-3">Your Organizations</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {myOrgs.map(org => (
                            <SpotlightCard
                                key={org.id}
                                className="p-0 flex flex-col h-full cursor-pointer"
                                spotlightColor="rgba(255, 191, 0, 0.08)"
                                onClick={() => router.push(`/organizations/${org.id}`)}
                            >
                                <CardHeader>
                                    <div className="flex items-start gap-4">
                                        <div className="w-12 h-12 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center shrink-0 overflow-hidden">
                                            {org.logoUrl ? (
                                                <img src={org.logoUrl} alt={org.name} className="w-full h-full object-cover" />
                                            ) : (
                                                <span className="text-xl font-bold text-amber-600 dark:text-amber-400">
                                                    {org.name.charAt(0).toUpperCase()}
                                                </span>
                                            )}
                                        </div>
                                        <div>
                                            <CardTitle className="text-lg line-clamp-1">{org.name}</CardTitle>
                                            <CardDescription className="flex items-center gap-1 mt-1">
                                                <Users className="w-3 h-3" />
                                                {org.members.length} {org.members.length === 1 ? 'member' : 'members'}
                                            </CardDescription>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent className="flex-1">
                                    <p className="text-sm text-muted-foreground line-clamp-3">
                                        {org.description || "No description provided."}
                                    </p>
                                </CardContent>
                                <CardFooter className="border-t border-border/50 pt-4">
                                    <Badge className={org.isPrivate
                                        ? "bg-muted text-muted-foreground"
                                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                                    }>
                                        {org.isPrivate ? "Private" : "Public"}
                                    </Badge>
                                </CardFooter>
                            </SpotlightCard>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Public Directory ── */}
            <div>
                <h2 className="text-lg font-semibold mb-3">Public Directory</h2>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                    </div>
                ) : filteredOrgs.length === 0 ? (
                    <SpotlightCard className="p-12 text-center" spotlightColor="rgba(255, 191, 0, 0.05)">
                        <Building2 className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
                        <h3 className="text-lg font-medium text-muted-foreground">No organizations found</h3>
                        <p className="text-sm text-muted-foreground/70 mt-1">
                            {searchQuery ? "Try adjusting your search terms." : "There are currently no public organizations."}
                        </p>
                    </SpotlightCard>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filteredOrgs.map(org => (
                            <SpotlightCard
                                key={org.id}
                                className="p-0 flex flex-col h-full cursor-pointer"
                                spotlightColor="rgba(255, 191, 0, 0.05)"
                                onClick={() => router.push(`/organizations/${org.id}`)}
                            >
                                <CardHeader>
                                    <div className="flex items-start gap-4">
                                        <div className="w-12 h-12 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center shrink-0 overflow-hidden">
                                            {org.logoUrl ? (
                                                <img src={org.logoUrl} alt={org.name} className="w-full h-full object-cover" />
                                            ) : (
                                                <span className="text-xl font-bold text-amber-600 dark:text-amber-400">
                                                    {org.name.charAt(0).toUpperCase()}
                                                </span>
                                            )}
                                        </div>
                                        <div>
                                            <CardTitle className="text-lg line-clamp-1">{org.name}</CardTitle>
                                            <CardDescription className="flex items-center gap-1 mt-1">
                                                <Users className="w-3 h-3" />
                                                {org.members.length} {org.members.length === 1 ? 'member' : 'members'}
                                            </CardDescription>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent className="flex-1">
                                    <p className="text-sm text-muted-foreground line-clamp-3">
                                        {org.description || "No description provided."}
                                    </p>
                                </CardContent>
                                <CardFooter className="border-t border-border/50 pt-4">
                                    <Button
                                        className="w-full bg-amber-600 hover:bg-amber-700 text-white"
                                        disabled={openingChannel === org.id || !currentOrg || currentOrg.id === org.id}
                                        onClick={(e) => handleStartChannel(e, org)}
                                    >
                                        {openingChannel === org.id ? (
                                            <span className="flex items-center justify-center gap-2">
                                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-black border-t-transparent" />
                                                Starting...
                                            </span>
                                        ) : currentOrg?.id === org.id ? (
                                            "Your Organization"
                                        ) : (
                                            "Start Channel"
                                        )}
                                    </Button>
                                </CardFooter>
                            </SpotlightCard>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
