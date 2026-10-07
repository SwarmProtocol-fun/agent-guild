/** Gig Editor — create or edit a service listing: seller, cover & gallery, single price or packages, FAQ. */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, User, Bot } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import { shortAddress } from "@/lib/chains";
import {
  createGig,
  updateGig,
  getAgentsByOrg,
  getProfile,
  GIG_PACKAGE_TIERS,
  type Agent,
  type Gig,
  type GigFaq,
} from "@/lib/firestore";
import {
  buildPackages,
  emptyPackageDraft,
  isHostedGigImage,
  packageToDraft,
  parsePriceNumber,
  startingTier,
  MAX_FAQS,
  MAX_GALLERY_IMAGES,
  type GigPackageDraft,
} from "@/lib/gig-packages";
import { cn } from "@/lib/utils";
import { GigImageSlot } from "./gig-image-picker";

export const GIG_CATEGORIES = ["Research", "Trading", "Operations", "Support", "Analytics", "Scout", "Content", "Dev", "Design", "Marketing", "Consulting"];

const SOLANA_ESCROW_AVAILABLE = process.env.NEXT_PUBLIC_WALLET_PROVIDER === "solana";
const LAMPORTS_PER_SOL = 1_000_000_000;
const PERSON = "__me__";

const label = "text-xs font-medium mb-1 block";
const req = <span className="text-red-500">*</span>;

export function GigEditor({ gig }: { gig?: Gig }) {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const account = useWalletAccount();
  const editing = !!gig;

  const [agents, setAgents] = useState<Agent[]>([]);
  const [myName, setMyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [seller, setSeller] = useState(gig ? (gig.sellerType === "person" ? PERSON : gig.agentId) : PERSON);
  const [title, setTitle] = useState(gig?.title ?? "");
  const [description, setDescription] = useState(gig?.description ?? "");
  const [category, setCategory] = useState(gig?.category ?? GIG_CATEGORIES[0]);
  const [tags, setTags] = useState((gig?.tags ?? []).join(", "));
  const [cover, setCover] = useState<string | undefined>(gig?.coverImageUrl);
  const [gallery, setGallery] = useState<string[]>(gig?.galleryUrls ?? []);

  const escrowLocked = editing; // escrow & SOL pricing are fixed once listed
  const [escrow, setEscrow] = useState(!!gig?.escrowEnabled);
  const [usePackages, setUsePackages] = useState((gig?.packages?.length ?? 0) > 0);
  const [price, setPrice] = useState(
    gig ? (gig.escrowEnabled && gig.priceLamports ? String(gig.priceLamports / LAMPORTS_PER_SOL) : String(parsePriceNumber(gig.price) || "")) : "",
  );
  const [deliveryDays, setDeliveryDays] = useState(String(gig?.deliveryDays ?? 3));
  const [drafts, setDrafts] = useState<GigPackageDraft[]>(() =>
    GIG_PACKAGE_TIERS.map((t) => {
      const existing = gig?.packages?.find((p) => p.id === t);
      return existing ? packageToDraft(existing, !!gig?.escrowEnabled) : emptyPackageDraft(t);
    }),
  );
  const [faqs, setFaqs] = useState<GigFaq[]>(gig?.faqs ?? []);

  useEffect(() => {
    if (!currentOrg) return;
    getAgentsByOrg(currentOrg.id).then(setAgents).catch(() => setAgents([]));
  }, [currentOrg]);

  useEffect(() => {
    if (!account?.address) return;
    getProfile(account.address)
      .then((p) => setMyName(p?.displayName?.trim() || shortAddress(account.address)))
      .catch(() => setMyName(shortAddress(account.address)));
  }, [account?.address]);

  const isPerson = seller === PERSON;
  const agent = agents.find((a) => a.id === seller);
  const escrowOn = escrow && !isPerson;
  const unit = escrowOn ? "SOL" : "$";

  const updateDraft = (i: number, patch: Partial<GigPackageDraft>) =>
    setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const handleSave = async () => {
    if (!currentOrg) return;
    if (!account?.address) return setError("Connect your wallet to publish");
    setError(null);
    if (!title.trim()) return setError("Give your gig a title");
    if (!isPerson && !agent && !editing) return setError("Choose who fulfils this gig");
    if (escrowOn && !editing && !agent?.solanaAddress) {
      return setError(`${agent?.name ?? "This agent"} has no Solana address on file — generate one before enabling escrow.`);
    }

    let pricing: Pick<Gig, "price" | "deliveryDays" | "priceLamports" | "packages">;
    if (usePackages) {
      const built = buildPackages(drafts, escrowOn);
      if ("error" in built) return setError(built.error);
      pricing = { ...startingTier(built.packages), packages: built.packages };
    } else {
      const amount = parsePriceNumber(price);
      if (!(amount > 0)) return setError("Enter a price above 0");
      pricing = {
        price: escrowOn ? `${amount} SOL` : String(amount),
        deliveryDays: Math.max(1, parseInt(deliveryDays, 10) || 1),
        ...(escrowOn ? { priceLamports: Math.round(amount * LAMPORTS_PER_SOL) } : {}),
        packages: [],
      };
    }

    const content = {
      title: title.trim().slice(0, 120),
      description: description.trim(),
      category,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8),
      coverImageUrl: cover && isHostedGigImage(cover) ? cover : "",
      galleryUrls: gallery.filter((u) => isHostedGigImage(u)).slice(0, MAX_GALLERY_IMAGES),
      faqs: faqs
        .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
        .filter((f) => f.question && f.answer)
        .slice(0, MAX_FAQS),
      ...pricing,
    };

    setSaving(true);
    try {
      if (gig) {
        await updateGig(gig.id, content);
        router.push(`/gigs/${gig.id}`);
      } else {
        const id = await createGig({
          ...content,
          tags: content.tags.length ? content.tags : agent?.capabilities?.slice(0, 5) ?? [],
          agentOrgId: currentOrg.id,
          status: "active",
          ...(isPerson
            ? { sellerType: "person" as const, sellerAddress: account.address, agentId: "", agentName: myName || shortAddress(account.address) }
            : { sellerType: "agent" as const, agentId: agent!.id, agentName: agent!.name }),
          ...(escrowOn ? { escrowEnabled: true, sellerSolanaAddress: agent!.solanaAddress } : {}),
        });
        router.push(`/gigs/${id}`);
      }
    } catch (err) {
      console.error("Failed to save gig:", err);
      setError(err instanceof Error ? err.message : "Failed to save gig");
      setSaving(false);
    }
  };

  if (!currentOrg) return <p className="text-muted-foreground">No organization selected</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-24">
      <div>
        <h1 className="text-xl font-semibold">{editing ? "Edit gig" : "Offer a service"}</h1>
        <p className="text-sm text-muted-foreground">List something you or one of your agents can do, with a clear price and what's included.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Overview</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className={label}>Who delivers this? {req}</label>
            <Select value={seller} onValueChange={setSeller}>
              <SelectTrigger disabled={editing}><SelectValue placeholder="Choose a seller" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={PERSON}>
                  <span className="inline-flex items-center gap-1.5"><User className="h-3.5 w-3.5" /> Me{myName ? ` (${myName})` : ""}</span>
                </SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="inline-flex items-center gap-1.5"><Bot className="h-3.5 w-3.5" /> {a.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isPerson && !editing && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Orders land in your Job Board&apos;s Orders tab and you deliver them yourself. Your profile display name is shown as the seller.
              </p>
            )}
          </div>
          <div>
            <label className={label}>Title {req}</label>
            <Input placeholder="e.g. I will audit your Solana program for common vulnerabilities" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className={label}>Description</label>
            <Textarea placeholder="What the buyer gets, how you work, and what you need from them to start..." value={description} onChange={(e) => setDescription(e.target.value)} rows={6} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label}>Category</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GIG_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className={label}>Tags</label>
              <Input placeholder="comma separated, e.g. solana, audit, rust" value={tags} onChange={(e) => setTags(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cover photo &amp; gallery</CardTitle>
          <CardDescription>The cover is what buyers see first when browsing. JPEG, PNG or WebP; large photos are resized for you.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <GigImageSlot url={cover} orgId={currentOrg.id} label="Add cover photo" className="aspect-[16/9] w-full max-w-xl" onChange={setCover} onError={setError} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: MAX_GALLERY_IMAGES }, (_, i) => (
              <GigImageSlot
                key={i}
                url={gallery[i]}
                orgId={currentOrg.id}
                label="Add image"
                className="aspect-[4/3]"
                onChange={(url) => setGallery((g) => {
                  const next = [...g];
                  if (url) next[i] = url; else next.splice(i, 1);
                  return next.filter(Boolean);
                })}
                onError={setError}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-base">Pricing</CardTitle>
              <CardDescription>One flat price, or Basic / Standard / Premium packages.</CardDescription>
            </div>
            <div className="inline-flex shrink-0 rounded-md border p-0.5 text-xs font-medium" role="radiogroup" aria-label="Pricing type">
              {([[false, "Single price"], [true, "Packages"]] as const).map(([value, text]) => (
                <button
                  key={text}
                  type="button"
                  role="radio"
                  aria-checked={usePackages === value}
                  onClick={() => setUsePackages(value)}
                  className={cn("rounded px-3 py-1.5 transition-colors", usePackages === value ? "bg-amber-600 text-white" : "text-muted-foreground hover:text-foreground")}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {SOLANA_ESCROW_AVAILABLE && !isPerson && (
            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer rounded-md border p-3">
              <input type="checkbox" checked={escrow} disabled={escrowLocked} onChange={(e) => setEscrow(e.target.checked)} className="h-3.5 w-3.5" />
              Real on-chain escrow in SOL — half paid upfront, half held until delivery is approved
              {escrowLocked && <span className="text-muted-foreground font-normal">(can&apos;t change after listing)</span>}
            </label>
          )}

          {usePackages ? (
            <div className="grid gap-3 md:grid-cols-3">
              {drafts.map((d, i) => (
                <div key={d.id} className="space-y-2 rounded-md border p-3">
                  <Input value={d.name} onChange={(e) => updateDraft(i, { name: e.target.value })} className="h-8 font-medium" maxLength={40} aria-label="Package name" />
                  <Textarea placeholder="Short summary of this tier" value={d.description} onChange={(e) => updateDraft(i, { description: e.target.value })} rows={2} className="text-xs" />
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[11px] text-muted-foreground">Price ({unit})</label>
                      <Input type="number" min="0" step={escrowOn ? "0.01" : "1"} value={d.price} onChange={(e) => updateDraft(i, { price: e.target.value })} className="h-8" />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground">Days</label>
                      <Input type="number" min="1" value={d.deliveryDays} onChange={(e) => updateDraft(i, { deliveryDays: e.target.value })} className="h-8" />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground">Revisions</label>
                      <Input type="number" min="0" value={d.revisions} onChange={(e) => updateDraft(i, { revisions: e.target.value })} className="h-8" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground">What&apos;s included (one per line)</label>
                    <Textarea value={d.features} onChange={(e) => updateDraft(i, { features: e.target.value })} rows={4} className="text-xs" placeholder={"Source files\n1 page report"} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 max-w-sm">
              <div>
                <label className={label}>Price ({unit}) {req}</label>
                <Input type="number" min="0" step={escrowOn ? "0.01" : "1"} placeholder={escrowOn ? "0.5" : "150"} value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
              <div>
                <label className={label}>Delivery (days)</label>
                <Input type="number" min="1" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">FAQ</CardTitle>
          <CardDescription>Answer what buyers usually ask before ordering.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {faqs.map((f, i) => (
            <div key={i} className="flex gap-2">
              <div className="flex-1 space-y-2">
                <Input placeholder="Question" value={f.question} onChange={(e) => setFaqs((fs) => fs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} />
                <Textarea placeholder="Answer" rows={2} value={f.answer} onChange={(e) => setFaqs((fs) => fs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))} />
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={() => setFaqs((fs) => fs.filter((_, j) => j !== i))} aria-label="Remove question">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {faqs.length < MAX_FAQS && (
            <Button type="button" variant="outline" size="sm" onClick={() => setFaqs((fs) => [...fs, { question: "", answer: "" }])}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add question
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <p className="min-w-0 truncate text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => router.back()} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="bg-amber-600 hover:bg-amber-700 text-white">
              {saving ? "Saving..." : editing ? "Save changes" : "Publish gig"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
