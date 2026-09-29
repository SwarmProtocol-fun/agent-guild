/** Organization Profile — Public-facing org page with details, messaging, and privacy toggle. */
"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogContent } from "@/components/ui/dialog";
import { Building2, Users, Globe, ExternalLink, ArrowLeft } from "lucide-react";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import {
    getOrganization,
    updateOrganization,
    createChannel,
    getChannelsByOrg,
    sendMessage,
    type Organization,
} from "@/lib/firestore";

export default function OrgProfilePage() {
    const params = useParams();
    const router = useRouter();
    const orgId = params.orgId as string;
    const account = useWalletAccount();
    const address = account?.address;
    const { currentOrg, refreshOrgs } = useOrg();

    const [org, setOrg] = useState<Organization | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Message dialog
    const [showMessageDialog, setShowMessageDialog] = useState(false);
    const [messageContent, setMessageContent] = useState("");
    const [sendingMessage, setSendingMessage] = useState(false);
    const [messageSuccess, setMessageSuccess] = useState(false);

    // Privacy toggle
    const [isPrivate, setIsPrivate] = useState(false);
    const [togglingPrivacy, setTogglingPrivacy] = useState(false);

    const isOwner = org && address && org.ownerAddress.toLowerCase() === address.toLowerCase();
    const canMessage = currentOrg && org && currentOrg.id !== org.id;

    useEffect(() => {
        async function load() {
            try {
                setLoading(true);
                setError(null);
                const data = await getOrganization(orgId);
                if (!data) {
                    setError("Organization not found");
                    return;
                }
                setOrg(data);
                setIsPrivate(data.isPrivate || false);
            } catch (err) {
                console.error("Failed to load organization:", err);
                setError(err instanceof Error ? err.message : "Failed to load organization");
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [orgId]);

    const handlePrivacyToggle = async (checked: boolean) => {
        if (!org || !isOwner) return;
        setTogglingPrivacy(true);
        try {
            setIsPrivate(checked);
            await updateOrganization(org.id, { isPrivate: checked });
            setOrg({ ...org, isPrivate: checked });
            await refreshOrgs();
        } catch {
            setIsPrivate(!checked);
        } finally {
            setTogglingPrivacy(false);
        }
    };

    const handleSendMessage = async () => {
        if (!currentOrg || !org || !messageContent.trim() || !address) return;
        setSendingMessage(true);
        try {
            const channels = await getChannelsByOrg(currentOrg.id);
            const channelName = `Chat w/ ${org.name}`;
            let chatChannel = channels.find(c => c.name === channelName);

            if (!chatChannel) {
                const id = await createChannel({
                    orgId: currentOrg.id,
                    name: channelName,
                    createdAt: new Date(),
                });
                chatChannel = { id, orgId: currentOrg.id, name: channelName, createdAt: new Date() };
            }

            await sendMessage({
                channelId: chatChannel.id,
                senderId: address,
                senderAddress: address,
                senderName: address.slice(0, 8) + "..." + address.slice(-6),
                senderType: "human",
                content: messageContent.trim(),
                orgId: currentOrg.id,
                createdAt: new Date(),
            });

            setMessageSuccess(true);
            setMessageContent("");
            setTimeout(() => router.push("/chat"), 1500);
        } catch (err) {
            console.error("Failed to send message:", err);
        } finally {
            setSendingMessage(false);
        }
    };

    const formatDate = (timestamp: unknown) => {
        if (!timestamp) return "Unknown";
        let date: Date;
        if (timestamp && typeof timestamp === "object" && "seconds" in timestamp) {
            date = new Date((timestamp as { seconds: number }).seconds * 1000);
        } else {
            date = new Date(timestamp as string | number);
        }
        return date.toLocaleDateString();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            </div>
        );
    }

    if (error || !org) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="text-center">
                    <Building2 className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
                    <h2 className="text-xl font-bold mb-2">Organization Not Found</h2>
                    <p className="text-muted-foreground mb-4">{error}</p>
                    <Button asChild variant="outline">
                        <Link href="/organizations">Back to Organizations</Link>
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-2xl">
            {/* Header */}
            <div className="flex items-start gap-4">
                <Link
                    href="/organizations"
                    className="text-muted-foreground hover:text-foreground transition-colors mt-2"
                >
                    <ArrowLeft className="w-5 h-5" />
                </Link>
                <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="w-16 h-16 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center overflow-hidden shrink-0">
                        {org.logoUrl ? (
                            <img src={org.logoUrl} alt={org.name} className="w-full h-full object-cover" />
                        ) : (
                            <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                                {org.name.charAt(0).toUpperCase()}
                            </span>
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h1 className="text-2xl font-bold tracking-tight">{org.name}</h1>
                            <Badge className={isPrivate
                                ? "bg-muted text-muted-foreground"
                                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                            }>
                                {isPrivate ? "Private" : "Public"}
                            </Badge>
                            {isOwner && (
                                <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                                    Owner
                                </Badge>
                            )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                            <Users className="w-4 h-4" />
                            {org.members.length} {org.members.length === 1 ? "member" : "members"}
                            <span className="text-muted-foreground/40">|</span>
                            Created {formatDate(org.createdAt)}
                        </p>
                    </div>
                </div>
                <div className="flex gap-2 shrink-0">
                    {canMessage && (
                        <Button
                            className="bg-amber-600 hover:bg-amber-700 text-white"
                            onClick={() => setShowMessageDialog(true)}
                        >
                            Send Message
                        </Button>
                    )}
                    {isOwner && (
                        <Button variant="outline" onClick={() => router.push("/settings")}>
                            Edit Settings
                        </Button>
                    )}
                </div>
            </div>

            {/* About */}
            {org.description && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">About</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{org.description}</p>
                    </CardContent>
                </Card>
            )}

            {/* Details */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Organization Details</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Members</span>
                            <span>{org.members.length}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Created</span>
                            <span>{formatDate(org.createdAt)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Visibility</span>
                            <span>{isPrivate ? "Private" : "Public"}</span>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Social Links */}
            {(org.website || org.twitter || org.discord || org.telegram) && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Social Links</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {org.website && (
                                <a
                                    href={org.website}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-2 text-sm text-amber-600 hover:text-amber-500 transition-colors"
                                >
                                    <Globe className="w-4 h-4" />
                                    <span className="truncate">{org.website}</span>
                                    <ExternalLink className="w-3 h-3 shrink-0" />
                                </a>
                            )}
                            {org.twitter && (
                                <a
                                    href={org.twitter.startsWith("@") ? `https://x.com/${org.twitter.slice(1)}` : org.twitter.startsWith("http") ? org.twitter : `https://x.com/${org.twitter}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-2 text-sm text-amber-600 hover:text-amber-500 transition-colors"
                                >
                                    <span className="font-medium">X</span>
                                    <span className="truncate">{org.twitter}</span>
                                    <ExternalLink className="w-3 h-3 shrink-0" />
                                </a>
                            )}
                            {org.discord && (
                                <a
                                    href={org.discord}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-2 text-sm text-amber-600 hover:text-amber-500 transition-colors"
                                >
                                    <span className="font-medium">Discord</span>
                                    <span className="truncate">{org.discord}</span>
                                    <ExternalLink className="w-3 h-3 shrink-0" />
                                </a>
                            )}
                            {org.telegram && (
                                <a
                                    href={org.telegram}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-2 text-sm text-amber-600 hover:text-amber-500 transition-colors"
                                >
                                    <span className="font-medium">Telegram</span>
                                    <span className="truncate">{org.telegram}</span>
                                    <ExternalLink className="w-3 h-3 shrink-0" />
                                </a>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Privacy Toggle — Owner Only */}
            {isOwner && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Privacy Settings</CardTitle>
                        <CardDescription>Control the visibility of your organization</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium">Private Organization</p>
                                <p className="text-sm text-muted-foreground">
                                    Hide your organization from the public directory.
                                </p>
                            </div>
                            <Switch
                                checked={isPrivate}
                                disabled={togglingPrivacy}
                                onCheckedChange={handlePrivacyToggle}
                            />
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Members */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Members</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-2">
                        {org.members.map((member, index) => (
                            <div key={index} className="flex items-center justify-between p-3 rounded-md bg-muted/50 border border-border/50">
                                <p className="text-sm font-mono">
                                    {member.slice(0, 8)}...{member.slice(-6)}
                                </p>
                                {member.toLowerCase() === org.ownerAddress.toLowerCase() && (
                                    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                                        Owner
                                    </Badge>
                                )}
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* Send Message Dialog */}
            <Dialog
                open={showMessageDialog}
                onOpenChange={(open) => {
                    setShowMessageDialog(open);
                    if (!open) {
                        setMessageContent("");
                        setMessageSuccess(false);
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>Send Message to {org.name}</DialogTitle>
                    <DialogDescription>
                        This will create a channel in your organization and send your message.
                    </DialogDescription>
                </DialogHeader>
                <DialogContent>
                    {messageSuccess ? (
                        <div className="py-4 text-center">
                            <p className="text-lg font-medium mb-1">Message sent!</p>
                            <p className="text-sm text-muted-foreground">Redirecting to chat...</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <Textarea
                                value={messageContent}
                                onChange={(e) => setMessageContent(e.target.value)}
                                placeholder={`Write a message to ${org.name}...`}
                                rows={4}
                                maxLength={2000}
                            />
                            <p className="text-xs text-muted-foreground">{messageContent.length}/2000</p>
                            <div className="flex gap-2 justify-end">
                                <Button
                                    variant="outline"
                                    onClick={() => setShowMessageDialog(false)}
                                    disabled={sendingMessage}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    onClick={handleSendMessage}
                                    disabled={sendingMessage || !messageContent.trim()}
                                    className="bg-amber-600 hover:bg-amber-700 text-white"
                                >
                                    {sendingMessage ? "Sending..." : "Send Message"}
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
