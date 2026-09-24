/** Onboarding — Step-by-step setup wizard for new users joining the platform. */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useOrg } from '@/contexts/OrgContext';
import { useDisconnectWallet } from "@/lib/wallet";

export default function OnboardingPage() {
  const router = useRouter();
  const { createOrg, refreshOrgs } = useOrg();
  const disconnectWallet = useDisconnectWallet();
  const [activeTab, setActiveTab] = useState<'create' | 'join'>('create');
  
  // Create state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  
  // Join state
  const [inviteCode, setInviteCode] = useState('');
  const [joining, setJoining] = useState(false);

  // Common state
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);

    try {
      await createOrg(name.trim(), description.trim() || undefined);
      router.push('/dashboard');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create organization';
      setError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    if (!inviteCode.trim() || inviteCode.trim().length !== 6) {
      setError('Please enter a valid 6-character invite code');
      return;
    }
    setJoining(true);
    setError(null);

    try {
      const res = await fetch('/api/v1/orgs/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode: inviteCode.trim().toUpperCase() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to join organization');
      }

      await refreshOrgs(); // refresh org context to pull new org
      router.push('/dashboard');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to join organization';
      setError(message);
    } finally {
      setJoining(false);
    }
  };

  return (
    <main className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6 pb-20">
      <Card className="w-full max-w-lg border-amber-500/30">
        <CardHeader className="text-center pb-4">
          <div className="text-5xl mb-4">⚡</div>
          <CardTitle className="text-2xl">Setup Your Workspace</CardTitle>
          <CardDescription>
            Join an existing team or create a new organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="p-3 mb-6 rounded-md bg-red-500/10 border border-red-500/50 text-sm text-red-500">
              {error}
            </div>
          )}

          <div className="flex bg-black/40 p-1 rounded-md mb-6 border border-white/5">
            <button
              onClick={() => { setActiveTab('create'); setError(null); }}
              className={`flex-1 text-sm font-medium py-2 rounded-sm transition-colors ${activeTab === 'create' ? 'bg-amber-500/10 text-amber-500 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Create New
            </button>
            <button
              onClick={() => { setActiveTab('join'); setError(null); }}
              className={`flex-1 text-sm font-medium py-2 rounded-sm transition-colors ${activeTab === 'join' ? 'bg-amber-500/10 text-amber-500 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Join Existing
            </button>
          </div>

          <div className="space-y-4">
            {activeTab === 'create' ? (
              <>
                <div>
                  <label className="text-sm font-medium mb-1.5 block text-muted-foreground">Organization Name</label>
                  <input
                    className="w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
                    placeholder="e.g. Acme AI Ops"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 block text-muted-foreground">Description (optional)</label>
                  <textarea
                    className="w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500 min-h-[80px]"
                    placeholder="What does your organization do?"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                  />
                </div>

                <Button
                  onClick={handleCreate}
                  disabled={creating || !name.trim()}
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold mt-2"
                >
                  {creating ? 'Creating...' : 'Create Organization'}
                </Button>
              </>
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium mb-1.5 block text-muted-foreground">Invite Code</label>
                  <input
                    className="w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-center text-lg tracking-[0.2em] font-mono uppercase focus:outline-none focus:ring-1 focus:ring-amber-500"
                    placeholder="XXXXXX"
                    maxLength={6}
                    value={inviteCode}
                    onChange={e => setInviteCode(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === 'Enter' && handleJoin()}
                  />
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    Ask your organization administrator for a 6-character invite code.
                  </p>
                </div>

                <Button
                  onClick={handleJoin}
                  disabled={joining || inviteCode.length !== 6}
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold mt-4"
                >
                  {joining ? 'Joining...' : 'Join Organization'}
                </Button>
              </>
            )}
          </div>

          <div className="flex items-center justify-center gap-4 mt-8 pt-4 border-t border-white/5">
            <button
              onClick={() => router.push('/')}
              className="text-xs text-muted-foreground hover:text-white transition-colors"
            >
              Cancel Setup
            </button>
            <span className="text-muted-foreground/30">•</span>
            <button
              onClick={() => { disconnectWallet(); router.push('/'); }}
              className="text-xs text-red-500/70 hover:text-red-500 transition-colors"
            >
              Disconnect Wallet
            </button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
