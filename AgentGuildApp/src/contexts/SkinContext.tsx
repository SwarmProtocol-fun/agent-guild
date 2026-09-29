/** SkinContext — Manages the active UI skin. Integrates with marketplace for installable skins. */
"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export interface SkinMeta {
  id: string;
  name: string;
  description: string;
  colors: [string, string, string]; // [primary, secondary, accent]
  /** Marketplace skill ID (for skins that require installation) */
  marketId?: string;
  /** Whether this skin is always available without installation */
  builtin?: boolean;
}

/** All known skins. Classic is builtin (always available). Others map to marketplace items. */
export const SKINS: SkinMeta[] = [
  { id: "classic", name: "Classic", description: "Amber & gold — the original Swarm look", colors: ["#FFD700", "#FFA500", "#FF8C00"], builtin: true },
  { id: "hedera", name: "⚡ HBAR Hashgraph", description: "Emerald & purple — Built on Hedera", colors: ["#10b981", "#a855f7", "#059669"], builtin: true, marketId: "skin-hedera" },
  { id: "futuristic", name: "Futuristic", description: "Cyan & magenta — Arwes-inspired sci-fi", colors: ["#26dafd", "#fc26fa", "#be26fc"], builtin: true, marketId: "skin-futuristic" },
  { id: "retro-terminal", name: "Retro Terminal", description: "CRT phosphor amber with scanlines & vignette", colors: ["#ff6a00", "#994400", "#331a00"], builtin: true, marketId: "skin-retro-terminal" },
  { id: "cyberpunk", name: "Cyberpunk", description: "Neon pink & electric purple — Night City vibes", colors: ["#ff1493", "#8a2be2", "#c026d3"], builtin: true, marketId: "skin-cyberpunk" },
  { id: "midnight", name: "Midnight", description: "Deep indigo & violet — refined elegance", colors: ["#6366f1", "#a855f7", "#818cf8"], builtin: true, marketId: "skin-midnight" },
  { id: "hacker", name: "Hacker Green", description: "Green phosphor terminal — Matrix aesthetic", colors: ["#00ff41", "#00802b", "#003311"], builtin: true, marketId: "skin-hacker" },
  { id: "jrpg", name: "JRPG Fantasy", description: "16-bit SNES-era Final Fantasy — pixel fonts, dialog boxes, quest menus", colors: ["#ffd700", "#4dccff", "#0a0a2e"], builtin: true, marketId: "skin-jrpg" },
  { id: "pokemon", name: "Pokemon Trainer", description: "Catch 'em all — agents live in Pokeballs, Pokemon-style UI", colors: ["#ee1515", "#ffffff", "#3b4cca"], builtin: true, marketId: "skin-pokemon" },
  { id: "mecha", name: "Mecha LaunchPad", description: "Industrial mech hangar — 3D robot agents on a launchpad", colors: ["#58a6ff", "#3fb950", "#d29922"], builtin: true, marketId: "skin-mecha" },
];

const STORAGE_KEY = "swarm-skin";
const SCANLINES_KEY = "swarm-scanlines";
const DEFAULT_SKIN = "classic";

interface SkinContextValue {
  skin: string;
  setSkin: (id: string) => void;
  skins: SkinMeta[];
  /** Subset of skins available to this user (builtin + installed) */
  availableSkins: SkinMeta[];
  /** Set of installed marketplace skin IDs */
  installedSkinIds: Set<string>;
  /** Refresh installed skins (call after marketplace install/uninstall) */
  refreshInstalled: (ownedSkillIds: string[]) => void;
  /** Whether CRT scan lines are enabled */
  scanLines: boolean;
  setScanLines: (enabled: boolean) => void;
}

const SkinContext = createContext<SkinContextValue>({
  skin: DEFAULT_SKIN,
  setSkin: () => {},
  skins: SKINS,
  availableSkins: SKINS.filter((s) => s.builtin),
  installedSkinIds: new Set(),
  refreshInstalled: () => {},
  scanLines: false,
  setScanLines: () => {},
});

function applySkinClass(skinId: string) {
  const root = document.documentElement;
  root.classList.forEach((cls) => {
    if (cls.startsWith("skin-")) root.classList.remove(cls);
  });
  if (skinId !== "classic") {
    root.classList.add(`skin-${skinId}`);
  }
}

function applyScanLinesClass(enabled: boolean) {
  const root = document.documentElement;
  if (enabled) {
    root.classList.add("crt-scanlines");
  } else {
    root.classList.remove("crt-scanlines");
  }
}

export function SkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkinState] = useState(DEFAULT_SKIN);
  const [installedSkinIds, setInstalledSkinIds] = useState<Set<string>>(new Set());
  const [scanLines, setScanLinesState] = useState(false);

  const availableSkins = SKINS.filter(
    (s) => s.builtin || (s.marketId && installedSkinIds.has(s.marketId))
  );

  // Read from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const valid = SKINS.some((s) => s.id === stored);
    const initial = valid ? stored! : DEFAULT_SKIN;
    setSkinState(initial);
    applySkinClass(initial);

    const storedScanLines = localStorage.getItem(SCANLINES_KEY);
    const scanLinesEnabled = storedScanLines === "true";
    setScanLinesState(scanLinesEnabled);
    applyScanLinesClass(scanLinesEnabled);
  }, []);

  const setSkin = useCallback((id: string) => {
    if (!SKINS.some((s) => s.id === id)) return;
    setSkinState(id);
    localStorage.setItem(STORAGE_KEY, id);
    applySkinClass(id);
  }, []);

  const setScanLines = useCallback((enabled: boolean) => {
    setScanLinesState(enabled);
    localStorage.setItem(SCANLINES_KEY, String(enabled));
    applyScanLinesClass(enabled);
  }, []);

  const refreshInstalled = useCallback((ownedSkillIds: string[]) => {
    const skinIds = new Set<string>();
    for (const skillId of ownedSkillIds) {
      if (skillId.startsWith("skin-")) skinIds.add(skillId);
    }
    setInstalledSkinIds(skinIds);
  }, []);

  // If the currently active skin gets uninstalled, revert to classic
  useEffect(() => {
    const current = SKINS.find((s) => s.id === skin);
    if (current && !current.builtin && current.marketId && !installedSkinIds.has(current.marketId)) {
      setSkin("classic");
    }
  }, [installedSkinIds, skin, setSkin]);

  return (
    <SkinContext.Provider value={{ skin, setSkin, skins: SKINS, availableSkins, installedSkinIds, refreshInstalled, scanLines, setScanLines }}>
      {children}
    </SkinContext.Provider>
  );
}

export function useSkin() {
  return useContext(SkinContext);
}
