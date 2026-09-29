/** Settings — User profile + organization configuration. */
'use client';

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useOrg } from '@/contexts/OrgContext';
import { useWalletAccount } from "@/lib/wallet";
import { updateOrganization, getProfile, setProfile, removeMemberFromOrganization } from '@/lib/firestore';

import { Badge } from '@/components/ui/badge';
// [swarm-core] GitHub + ReactBits extracted to mods
const GitHubIcon = ({ className }: { className?: string }) => <span className={className}>GH</span>;
const SpotlightCard = ({ children, className, ...props }: { children: React.ReactNode; className?: string; [k: string]: unknown }) => <div className={className}>{children}</div>;
import { Switch } from '@/components/ui/switch';
import { useSkin } from '@/contexts/SkinContext';
import { getOwnedItems } from '@/lib/skills';
import Link from 'next/link';

export default function SettingsPage() {
  const { currentOrg, refreshOrgs } = useOrg();
  const account = useWalletAccount();
  const address = account?.address;
  const { skin, setSkin, skins, availableSkins, refreshInstalled, scanLines, setScanLines } = useSkin();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingSocials, setSavingSocials] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [discord, setDiscord] = useState('');
  const [telegram, setTelegram] = useState('');

  const [disconnectingGH, setDisconnectingGH] = useState(false);
  const [ghSlugInput, setGhSlugInput] = useState('');
  const [ghMessage, setGhMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // User profile state
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [userBio, setUserBio] = useState('');
  const [userAvatar, setUserAvatar] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // Load installed skins from marketplace inventory
  useEffect(() => {
    if (!currentOrg) return;
    (async () => {
      try {
        const owned = await getOwnedItems(currentOrg.id);
        refreshInstalled(owned.filter(o => o.enabled).map(o => o.skillId));
      } catch { /* non-fatal */ }
    })();
  }, [currentOrg, refreshInstalled]);

  // Load user profile
  useEffect(() => {
    if (!address) return;
    (async () => {
      try {
        const profile = await getProfile(address);
        if (profile) {
          setDisplayName(profile.displayName || '');
          setEmail(profile.email || '');
          setUserBio(profile.bio || '');
          setUserAvatar(profile.avatar || null);
        }
        setProfileLoaded(true);
      } catch {
        setProfileLoaded(true);
      }
    })();
  }, [address]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) return;
    setSavingProfile(true);
    setProfileMessage(null);
    try {
      await setProfile(address, {
        displayName: displayName.trim(),
        email: email.trim(),
        bio: userBio.trim(),
        ...(userAvatar ? { avatar: userAvatar } : {}),
      });
      setProfileMessage({ type: 'success', text: 'Profile updated!' });
    } catch (err) {
      setProfileMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save profile' });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !address) return;
    if (file.size > 500 * 1024) {
      setProfileMessage({ type: 'error', text: 'Avatar must be under 500KB' });
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      setUserAvatar(base64);
      try {
        await setProfile(address, { avatar: base64 });
        setProfileMessage({ type: 'success', text: 'Avatar updated!' });
      } catch {
        setProfileMessage({ type: 'error', text: 'Failed to save avatar' });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Initialize form with current org data
  useEffect(() => {
    if (currentOrg) {
      setName(currentOrg.name);
      setDescription(currentOrg.description || '');
      setIsPrivate(currentOrg.isPrivate || false);
      setLogoPreview(currentOrg.logoUrl || null);
      setWebsite(currentOrg.website || '');
      setTwitter(currentOrg.twitter || '');
      setDiscord(currentOrg.discord || '');
      setTelegram(currentOrg.telegram || '');
    }
  }, [currentOrg]);

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentOrg) return;

    if (file.size > 500 * 1024) {
      setMessage({ type: 'error', text: 'Image must be under 500KB' });
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      setLogoPreview(base64);
      try {
        await updateOrganization(currentOrg.id, { logoUrl: base64 });
        await refreshOrgs();
        setMessage({ type: 'success', text: 'Logo updated!' });
      } catch {
        setMessage({ type: 'error', text: 'Failed to save logo' });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSaveSocials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg) return;
    setSavingSocials(true);
    setMessage(null);
    try {
      await updateOrganization(currentOrg.id, {
        website: website.trim(),
        twitter: twitter.trim(),
        discord: discord.trim(),
        telegram: telegram.trim(),
      });
      await refreshOrgs();
      setMessage({ type: 'success', text: 'Social links updated!' });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update social links' });
    } finally {
      setSavingSocials(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg) return;

    setSaving(true);
    setMessage(null);

    try {
      await updateOrganization(currentOrg.id, {
        name: name.trim(),
        description: description.trim() || '',
      });

      // Refresh org data to reflect changes
      await refreshOrgs();

      setMessage({ type: 'success', text: 'Organization settings updated successfully!' });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update organization',
      });
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (timestamp: unknown) => {
    if (!timestamp) return 'Unknown';

    let date: Date;
    if (timestamp && typeof timestamp === 'object' && 'seconds' in timestamp) {
      date = new Date((timestamp as any).seconds * 1000);
    } else {
      date = new Date(timestamp as any);
    }

    return date.toLocaleDateString();
  };

  if (!currentOrg) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground mt-1">No organization selected</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="max-w-2xl space-y-6">

        {/* ── Appearance ── */}
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Customize the look and feel of Swarm. Get more skins from the <Link href="/market" className="text-primary underline underline-offset-2 hover:opacity-80">Marketplace</Link>.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {skins.map((s) => {
                const isActive = skin === s.id;
                const isAvailable = availableSkins.some((a) => a.id === s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => isAvailable && setSkin(s.id)}
                    disabled={!isAvailable}
                    className={`relative text-left rounded-xl border-2 p-4 transition-all duration-200 ${
                      isActive
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                        : isAvailable
                          ? 'border-border hover:border-muted-foreground/30 bg-card'
                          : 'border-border bg-card/50 opacity-60 cursor-not-allowed'
                    }`}
                  >
                    {isActive && (
                      <span className="absolute top-2 right-2 text-xs bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full font-medium">
                        Active
                      </span>
                    )}
                    {!isAvailable && (
                      <span className="absolute top-2 right-2 text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full font-medium">
                        Install from Market
                      </span>
                    )}
                    <div className="flex items-center gap-2 mb-2">
                      {s.colors.map((color, i) => (
                        <span
                          key={i}
                          className="w-4 h-4 rounded-full border border-border/50"
                          style={{ backgroundColor: color, filter: isAvailable ? 'none' : 'grayscale(0.5)' }}
                        />
                      ))}
                    </div>
                    <p className="text-sm font-semibold">{s.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{s.description}</p>
                  </button>
                );
              })}
            </div>

            <div className="mt-5 pt-5 border-t border-border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">CRT Scan Lines</p>
                  <p className="text-xs text-muted-foreground">
                    Retro CRT monitor effect with scan lines overlay
                  </p>
                </div>
                <Switch
                  checked={scanLines}
                  onCheckedChange={setScanLines}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── User Profile ── */}
        <Card>
          <CardHeader>
            <CardTitle>Your Profile</CardTitle>
            <CardDescription>Your personal settings across all organizations</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveProfile} className="space-y-5">
              <div className="flex items-center gap-4">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handleAvatarChange}
                />
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  className="w-16 h-16 rounded-full border border-border bg-muted flex items-center justify-center overflow-hidden cursor-pointer hover:opacity-80 transition-opacity shrink-0"
                >
                  {userAvatar ? (
                    <img src={userAvatar} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-xl font-bold text-muted-foreground">
                      {displayName ? displayName.charAt(0).toUpperCase() : address?.slice(2, 4).toUpperCase()}
                    </span>
                  )}
                </button>
                <div className="text-sm text-muted-foreground">
                  <p className="font-medium text-foreground font-mono text-xs">
                    {address ? `${address.slice(0, 8)}...${address.slice(-6)}` : ''}
                  </p>
                  <button type="button" onClick={() => avatarInputRef.current?.click()} className="text-[10px] text-muted-foreground hover:text-foreground mt-0.5">
                    Change avatar
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">Display Name</label>
                <Input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="How others see you"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">Email</label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Contact email — used for platform notifications
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">Bio</label>
                <Textarea
                  value={userBio}
                  onChange={(e) => setUserBio(e.target.value)}
                  rows={2}
                  placeholder="A short description about yourself"
                  maxLength={300}
                />
                <p className="text-xs text-muted-foreground mt-1">{userBio.length}/300</p>
              </div>

              {profileMessage && (
                <div className={`text-sm rounded-md p-3 ${profileMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                  : 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800'
                  }`}>
                  {profileMessage.text}
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={savingProfile || !profileLoaded}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {savingProfile ? 'Saving...' : 'Save Profile'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* ── Organization Profile ── */}
        <Card>
          <CardHeader>
            <CardTitle>Organization Profile</CardTitle>
            <CardDescription>Update your organization information</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="space-y-5">
              <div className="flex items-center gap-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handleLogoChange}
                />
                <div className="flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-16 h-16 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
                  >
                    {logoPreview ? (
                      <img src={logoPreview} alt="Logo" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">{currentOrg.name.charAt(0).toUpperCase()}</span>
                    )}
                  </button>
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="text-[10px] text-muted-foreground hover:text-foreground">📷 Change Logo</button>
                </div>
                <div className="text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">{currentOrg.name}</p>
                  <p className="text-xs">Created {formatDate(currentOrg.createdAt)}</p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Organization Name <span className="text-red-500">*</span>
                </label>
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Organization name"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">Description</label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="What does your organization do?"
                />
              </div>

              {currentOrg.inviteCode && (
                <div>
                  <label className="block text-sm font-medium mb-1.5">Invite Code</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md border border-amber-300 bg-amber-950/30 px-3 py-2 text-lg font-bold tracking-widest text-amber-400">
                      {currentOrg.inviteCode}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(currentOrg.inviteCode || '');
                      }}
                    >
                      📋 Copy
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Share this code to invite agents to your organization</p>
                </div>
              )}

              {message && (
                <div className={`text-sm rounded-md p-3 ${message.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                  : 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800'
                  }`}>
                  {message.text}
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={saving || !name.trim() || (name === currentOrg.name && description === (currentOrg.description || ''))}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Social Links</CardTitle>
            <CardDescription>Add links for the organization marketplace</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveSocials} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">🌐 Website</label>
                <Input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://yoursite.com" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">𝕏 Twitter / X</label>
                <Input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@yourhandle" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">💬 Discord</label>
                <Input value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="https://discord.gg/invite" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">✈️ Telegram</label>
                <Input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/yourchannel" />
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={savingSocials} className="bg-amber-600 hover:bg-amber-700 text-white">
                  {savingSocials ? 'Saving...' : 'Save Social Links'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Privacy Settings</CardTitle>
            <CardDescription>Control the visibility of your organization</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Private Organization</p>
                <p className="text-sm text-muted-foreground">
                  Hide your organization from the public Organizations directory.
                </p>
              </div>
              <Switch
                checked={isPrivate}
                onCheckedChange={async (checked) => {
                  setIsPrivate(checked);
                  if (currentOrg) {
                    await updateOrganization(currentOrg.id, { isPrivate: checked });
                    await refreshOrgs();
                  }
                }}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitHubIcon className="w-5 h-5" />
              GitHub Integration
            </CardTitle>
            <CardDescription>Connect your GitHub organization or account to link repos to projects</CardDescription>
          </CardHeader>
          <CardContent>
            {currentOrg.githubInstallationId ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
                  {currentOrg.githubAccountAvatarUrl && (
                    <img
                      src={currentOrg.githubAccountAvatarUrl}
                      alt={currentOrg.githubAccountLogin || ''}
                      className="w-10 h-10 rounded-full"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{currentOrg.githubAccountLogin}</p>
                    <p className="text-xs text-muted-foreground">
                      {currentOrg.githubAccountType} · Connected {formatDate(currentOrg.githubConnectedAt)}
                    </p>
                  </div>
                  <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                    Connected
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                  >
                    <a
                      href={`https://github.com/settings/installations/${currentOrg.githubInstallationId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Manage Permissions
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                    disabled={disconnectingGH}
                    onClick={async () => {
                      setDisconnectingGH(true);
                      try {
                        await fetch('/api/github/disconnect', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ orgId: currentOrg.id }),
                        });
                        await refreshOrgs();
                        setGhMessage({ type: 'success', text: 'GitHub disconnected' });
                      } catch {
                        setGhMessage({ type: 'error', text: 'Failed to disconnect GitHub' });
                      } finally {
                        setDisconnectingGH(false);
                      }
                    }}
                  >
                    {disconnectingGH ? 'Disconnecting...' : 'Disconnect'}
                  </Button>
                </div>
                {ghMessage && (
                  <div className={`text-sm rounded-md p-3 ${ghMessage.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                    : 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800'
                    }`}>
                    {ghMessage.text}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Install the GitHub App to connect repositories, view PRs, commits, and issues directly in your projects.
                </p>
                {process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ? (
                  <Button
                    className="bg-[#24292f] hover:bg-[#32383f] text-white"
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/github/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId: currentOrg.id }) });
                        const { state } = await res.json();
                        window.location.href = `https://github.com/apps/${process.env.NEXT_PUBLIC_GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
                      } catch {
                        window.location.href = `https://github.com/apps/${process.env.NEXT_PUBLIC_GITHUB_APP_SLUG}/installations/new?state=${currentOrg.id}`;
                      }
                    }}
                  >
                    <GitHubIcon className="w-4 h-4 mr-2" />
                    Install GitHub App
                  </Button>
                ) : (
                  <div className="space-y-3">
                    <div className="p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                      <p className="text-xs text-amber-700 dark:text-amber-400 mb-2">
                        No GitHub App configured. Enter your GitHub App slug below, or set <code className="font-mono bg-amber-100 dark:bg-amber-900/50 px-1 rounded">NEXT_PUBLIC_GITHUB_APP_SLUG</code> in your environment.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        placeholder="your-github-app-slug"
                        value={ghSlugInput}
                        onChange={(e) => setGhSlugInput(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        className="bg-[#24292f] hover:bg-[#32383f] text-white shrink-0"
                        disabled={!ghSlugInput.trim()}
                        onClick={async () => {
                          const slug = ghSlugInput.trim();
                          if (slug) {
                            try {
                              const res = await fetch("/api/github/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId: currentOrg.id }) });
                              const { state } = await res.json();
                              window.location.href = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
                            } catch {
                              window.location.href = `https://github.com/apps/${slug}/installations/new?state=${currentOrg.id}`;
                            }
                          }
                        }}
                      >
                        <GitHubIcon className="w-4 h-4 mr-2" />
                        Install
                      </Button>
                    </div>
                  </div>
                )}
                {ghMessage && (
                  <div className={`text-sm rounded-md p-3 ${ghMessage.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                    : 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800'
                    }`}>
                    {ghMessage.text}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>Organization members and their roles</CardDescription>
          </CardHeader>
          <CardContent>
            {message && message.text.includes('Member') && (
              <div className={`mb-4 text-sm rounded-md p-3 ${message.type === 'success'
                ? 'bg-emerald-50 text-emerald-600 border border-green-200'
                : 'bg-red-50 text-red-600 border border-red-200'
                }`}>
                {message.text}
              </div>
            )}
            <div className="space-y-3">
              {/* Owner */}
              <div className="flex items-center justify-between p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                <div>
                  <p className="text-sm font-medium">
                    {currentOrg.ownerAddress.slice(0, 8)}...{currentOrg.ownerAddress.slice(-6)}
                  </p>
                  <p className="text-xs text-muted-foreground">Owner</p>
                </div>
                <span className="text-xs bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400 px-2 py-1 rounded-full">
                  Admin
                </span>
              </div>

              {/* Additional members */}
              {currentOrg.members
                .filter(member => member !== currentOrg.ownerAddress)
                .map((member, index) => (
                  <div key={index} className="flex items-center justify-between p-3 rounded-md bg-muted border border-border">
                    <div>
                      <p className="text-sm font-medium">
                        {member.slice(0, 8)}...{member.slice(-6)}
                      </p>
                      <p className="text-xs text-muted-foreground">Member</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs bg-muted text-muted-foreground px-2 py-1 rounded-full">
                        Member
                      </span>
                      {address === currentOrg.ownerAddress && (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="text-red-500 hover:text-red-700 hover:bg-red-500/10 h-7 text-xs px-2"
                          onClick={async () => {
                            if (!confirm(`Are you sure you want to remove ${member.slice(0, 6)}... from the organization?`)) return;
                            try {
                              await removeMemberFromOrganization(currentOrg.id, member);
                              await refreshOrgs();
                              setMessage({ type: 'success', text: 'Member removed successfully' });
                            } catch (err) {
                              setMessage({ type: 'error', text: 'Failed to remove member' });
                            }
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              }
            </div>

            <div className="mt-4 text-sm text-muted-foreground">
              <p>Total members: {currentOrg.members.length}</p>
            </div>

            {currentOrg.inviteCode && (
               <div className="mt-6 p-4 rounded-md border border-amber-500/30 bg-amber-500/5">
                 <p className="text-sm font-medium mb-2 text-amber-500">Invite New Members</p>
                 <p className="text-xs text-muted-foreground mb-3">
                   Share this 6-character code with your team. They can enter it during onboarding to join this organization.
                 </p>
                 <div className="flex items-center gap-2">
                   <code className="flex-1 rounded-md border border-amber-300 bg-black/50 px-3 py-2 text-center text-lg font-mono font-bold tracking-widest text-amber-400">
                     {currentOrg.inviteCode}
                   </code>
                   <Button
                     type="button"
                     className="bg-amber-600 hover:bg-amber-700 text-white"
                     onClick={() => {
                       navigator.clipboard.writeText(currentOrg.inviteCode || '');
                       setMessage({ type: 'success', text: 'Invite code copied to clipboard!' });
                     }}
                   >
                     📋 Copy Code
                   </Button>
                 </div>
               </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Organization Info</CardTitle>
            <CardDescription>Read-only organization details</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Organization ID:</span>
                <span className="font-mono text-xs truncate max-w-[200px]">{currentOrg.id}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Owner Address:</span>
                <span className="font-mono text-xs">
                  {currentOrg.ownerAddress.slice(0, 8)}...{currentOrg.ownerAddress.slice(-6)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created:</span>
                <span>{formatDate(currentOrg.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Member Count:</span>
                <span>{currentOrg.members.length}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-red-600">Danger Zone</CardTitle>
            <CardDescription>Irreversible and destructive actions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Once you delete an organization, there is no going back. All projects, agents,
                tasks, and chat history will be permanently removed.
              </p>
              <Button variant="outline" size="sm" className="text-red-600 border-red-200 hover:bg-red-50" disabled>
                Delete Organization (coming soon)
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}