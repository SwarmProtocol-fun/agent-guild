/** Header — Top navigation bar with org/project selectors, theme toggle, notifications, and wallet connect. */
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { ConnectWalletButton, useWalletAccount } from "@/lib/wallet";
import { useOrg } from '@/contexts/OrgContext';
import { getProjectsByOrg, createProject, createOrganization, type Project } from '@/lib/firestore';
import GradientText from '@/components/reactbits/GradientText';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { NotificationCenter } from '@/components/notification-center';
import { useSkin, SKINS } from '@/contexts/SkinContext';
import { useSession } from '@/contexts/SessionContext';


/** Shows wallet address (truncated) when session is valid but wallet isn't connected.
 *  Falls through to full ConnectButton when wallet IS connected. */
function WalletDisplay() {
  const account = useWalletAccount();
  const { address: sessionAddress, authenticated, logout } = useSession();
  const [showMenu, setShowMenu] = useState(false);

  // Wallet connected → use the wallet button (shows address, opens account modal)
  if (account) {
    return <ConnectWalletButton />;
  }

  // Session valid but wallet not connected → show truncated address badge
  if (authenticated && sessionAddress) {
    const truncated = `${sessionAddress.slice(0, 6)}...${sessionAddress.slice(-4)}`;
    return (
      <div className="relative">
        <button
          onClick={() => setShowMenu(prev => !prev)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 transition-colors text-sm font-mono text-amber-400"
          title={sessionAddress}
        >
          <span className="w-2 h-2 rounded-full bg-green-500" />
          {truncated}
        </button>
        {showMenu && (
          <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg py-1 z-50 min-w-[160px]">
            <div
              onClick={() => { setShowMenu(false); }}
              className="w-full text-left px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50"
            >
              <ConnectWalletButton label="Connect Wallet" />
            </div>
            <button
              onClick={async () => { setShowMenu(false); await logout(); }}
              className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-muted/50"
            >
              Sign Out
            </button>
          </div>
        )}
      </div>
    );
  }

  // Not authenticated → show Connect button
  return <ConnectWalletButton label="Connect" />;
}

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const account = useWalletAccount();
  const isConnected = !!account;
  const { theme, setTheme } = useTheme();
  const { skin } = useSkin();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { currentOrg, organizations, selectOrg, refreshOrgs } = useOrg();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgDescription, setNewOrgDescription] = useState('');
  const [creatingOrg, setCreatingOrg] = useState(false);

  const projectMatch = pathname.match(/\/agent-guilds\/([^/]+)/);
  const currentProjectId = projectMatch?.[1] || '';

  const fetchProjects = useCallback(async () => {
    if (!currentOrg) { setProjects([]); return; }
    try {
      const res = await getProjectsByOrg(currentOrg.id);
      setProjects(res);
    } catch { setProjects([]); }
  }, [currentOrg]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const handleCreateOrg = async () => {
    if (!newOrgName.trim() || !account?.address) return;
    setCreatingOrg(true);
    try {
      const id = await createOrganization({
        name: newOrgName.trim(),
        description: newOrgDescription.trim() || '',
        ownerAddress: account.address,
        members: [account.address],
        createdAt: null,
      });
      setNewOrgName('');
      setNewOrgDescription('');
      setShowCreateOrg(false);
      await refreshOrgs();
      selectOrg(id);
    } catch (err) {
      console.error('Failed to create org:', err);
    } finally {
      setCreatingOrg(false);
    }
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim() || !currentOrg) return;
    setCreatingProject(true);
    try {
      const id = await createProject({
        name: newProjectName.trim(),
        description: '',
        orgId: currentOrg.id,
        status: 'active',
        agentIds: [],
        createdAt: null,
      });
      setNewProjectName('');
      setShowCreateProject(false);
      await fetchProjects();
      router.push(`/agent-guilds/${id}`);
    } catch (err) {
      console.error('Failed to create project:', err);
    } finally {
      setCreatingProject(false);
    }
  };

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b border-gray-200 dark:border-amber-500/10 bg-white/95 dark:bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:supports-[backdrop-filter]:bg-black/60 dark:neon-glow-gold">
        <div className="flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2">
              <Image src="/logo.png" alt="Agent Guild Logo" width={32} height={32} />
              <GradientText colors={SKINS.find(s => s.id === skin)?.colors ?? ['#7221FA', '#5B8FFD', '#27A0FD']} animationSpeed={4} className="text-lg font-bold text-glow-gold">Agent Guild</GradientText>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            {isConnected && <NotificationCenter />}
            {isConnected && currentOrg && organizations.length > 0 && (
              <>
                {currentOrg.logoUrl && (
                  <img src={currentOrg.logoUrl} alt="" className="w-6 h-6 rounded object-cover" />
                )}
                <select
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm text-muted-foreground max-w-[160px]"
                  value={currentOrg.id}
                  onChange={(e) => {
                    if (e.target.value === '__create_org__') {
                      setShowCreateOrg(true);
                      e.target.value = currentOrg.id;
                    } else {
                      selectOrg(e.target.value);
                    }
                  }}
                  title="Switch Organization"
                >
                  {organizations.map(org => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                  <option value="__create_org__">+ New Org</option>
                </select>
                <span className="text-muted-foreground text-sm">/</span>
                <select
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm text-muted-foreground max-w-[160px]"
                  value={currentProjectId}
                  onChange={(e) => {
                    if (e.target.value === '__create__') {
                      setShowCreateProject(true);
                      e.target.value = currentProjectId;
                    } else if (e.target.value) {
                      router.push(`/agent-guilds/${e.target.value}`);
                    }
                  }}
                  title="Switch Project"
                >
                  <option value="">Select project...</option>
                  {projects.map(proj => (
                    <option key={proj.id} value={proj.id}>📁 {proj.name}</option>
                  ))}
                  <option value="__create__">+ Project</option>
                </select>
              </>
            )}
            {mounted && (
              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="p-2 rounded-md border border-amber-500/20 hover:border-amber-500/40 transition-colors text-amber-400 hover:text-amber-300"
                title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            )}
            <WalletDisplay />
          </div>
        </div>
      </header>
      <Dialog open={showCreateProject} onOpenChange={setShowCreateProject}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <Input
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject(); }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreateProject(false)}>Cancel</Button>
              <Button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim() || creatingProject}
                className="bg-amber-500 hover:bg-amber-600 text-black"
              >
                {creatingProject ? 'Creating...' : 'Create Project'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showCreateOrg} onOpenChange={setShowCreateOrg}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>Create New Organization</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <Input
              placeholder="Organization name"
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateOrg(); }}
              autoFocus
            />
            <Input
              placeholder="Description (optional)"
              value={newOrgDescription}
              onChange={(e) => setNewOrgDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateOrg(); }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreateOrg(false)}>Cancel</Button>
              <Button
                onClick={handleCreateOrg}
                disabled={!newOrgName.trim() || creatingOrg}
                className="bg-amber-500 hover:bg-amber-600 text-black"
              >
                {creatingOrg ? 'Creating...' : 'Create Organization'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
