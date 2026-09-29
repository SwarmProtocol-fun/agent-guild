/** Profile — User profile and account preferences. */
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWalletAccount } from "@/lib/wallet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getProfile, setProfile } from "@/lib/firestore";
import SpotlightCard from "@/components/reactbits/SpotlightCard";

export default function ProfilePage() {
  const account = useWalletAccount();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!account?.address) return;
    getProfile(account.address).then((p) => {
      if (p) {
        setDisplayName(p.displayName || "");
        setBio(p.bio || "");
      }
      setLoaded(true);
    });
  }, [account, router]);

  const handleSave = async () => {
    if (!account?.address) return;
    setSaving(true);
    setSaved(false);
    try {
      await setProfile(account.address, { displayName, bio });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  if (!account?.address || !loaded) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-muted-foreground">
        Loading...
      </div>
    );
  }

  const addr = account.address;
  const truncated = addr.slice(0, 6) + "..." + addr.slice(-4);

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-6 md:p-10">
      <div className="max-w-lg mx-auto">
        <SpotlightCard className="p-0 border-[#1a1a2e] bg-[#0f0f1a]" spotlightColor="rgba(212, 168, 83, 0.1)">
          <CardHeader>
            <CardTitle className="text-[#d4a853]">Profile</CardTitle>
            <p className="text-sm text-muted-foreground font-mono">{truncated}</p>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-sm text-muted-foreground">
                Display Name
              </Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Enter your name..."
                className="bg-[#1a1a2e] border-[#2a2a3e] focus:border-[#d4a853] text-white"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bio" className="text-sm text-muted-foreground">
                Bio
              </Label>
              <Textarea
                id="bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Tell us about yourself..."
                rows={4}
                className="bg-[#1a1a2e] border-[#2a2a3e] focus:border-[#d4a853] text-white resize-none"
              />
            </div>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full bg-[#d4a853] hover:bg-[#c49a48] text-white font-semibold"
            >
              {saving ? "Saving..." : saved ? "✓ Saved!" : "Save Profile"}
            </Button>
          </CardContent>
        </SpotlightCard>
      </div>
    </div>
  );
}
