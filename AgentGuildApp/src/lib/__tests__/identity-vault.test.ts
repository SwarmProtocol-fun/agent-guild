import { beforeEach, describe, expect, it, vi } from "vitest";

type Data = Record<string, unknown>;

const db = vi.hoisted(() => {
  const cols = new Map<string, Map<string, Data>>();
  function bucket(name: string) {
    let rows = cols.get(name);
    if (!rows) {
      rows = new Map();
      cols.set(name, rows);
    }
    return rows;
  }
  return {
    clear() { cols.clear(); },
    admin() {
      return {
        collection(name: string) {
          return {
            doc(id: string) {
              return {
                async get() {
                  const data = bucket(name).get(id);
                  return { exists: data != null, data: () => data };
                },
                async set(data: Data) { bucket(name).set(id, { ...data }); },
                async delete() { bucket(name).delete(id); },
              };
            },
            where(field: string, _op: string, value: unknown) {
              return {
                get: async () => ({
                  docs: [...bucket(name).entries()]
                    .filter(([, data]) => data[field] === value)
                    .map(([id, data]) => ({ id, data: () => data })),
                }),
              };
            },
          };
        },
      };
    },
  };
});

const getAgent = vi.hoisted(() => vi.fn());
const fetchIdentityCopyOwner = vi.hoisted(() => vi.fn());
const platformIdentityHolder = vi.hoisted(() => vi.fn());

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db.admin() }));
vi.mock("@/lib/firestore-admin", () => ({ getAgent }));
vi.mock("@/lib/solana/identity-nft", () => ({ fetchIdentityCopyOwner, platformIdentityHolder }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => ({ toDate: () => new Date("2026-10-04T00:00:00Z") }) } }));

const HOLDERS: Record<string, string> = {
  PlatAsset: "PlatformAddr",
  Asset111: "AgentAddr111",
  OwnerAsset: "UserAddr",
};

const AGENT = {
  id: "a1",
  orgId: "o1",
  solanaAddress: "AgentAddr111",
  nftPlatformAssetAddress: "PlatAsset",
  nftAgentAssetAddress: "Asset111",
  nftMintAddress: "Asset111",
  nftOwnerAssetAddress: "OwnerAsset",
  nftOwnerSolanaAddress: "UserAddr",
};

const RECIPIENTS = { protocol: "PlatformAddr", agent: "AgentAddr111", user: "UserAddr" };

function b64(size: number, fill = 7): string {
  return Buffer.alloc(size, fill).toString("base64");
}

function wrap(fill: number) {
  return { eph: b64(32, fill), nonce: b64(12, fill), boxed: b64(48, fill) };
}

function box(user: ReturnType<typeof wrap> | null = wrap(3)) {
  return {
    v: 2,
    ciphertext: b64(32, 9),
    nonce: b64(12, 8),
    wraps: { protocol: wrap(1), agent: wrap(2), user },
  };
}

beforeEach(() => {
  db.clear();
  getAgent.mockReset();
  fetchIdentityCopyOwner.mockReset();
  platformIdentityHolder.mockReset();
  getAgent.mockResolvedValue(AGENT);
  platformIdentityHolder.mockReturnValue("PlatformAddr");
  fetchIdentityCopyOwner.mockImplementation(async (asset: string) => HOLDERS[asset] ?? null);
});

describe("identity vault", () => {
  it("names the protocol, agent, and user only while each copy is held by them", async () => {
    const { unlockIdentityVault, VaultError } = await import("../identity-vault");
    await expect(unlockIdentityVault("a1")).resolves.toEqual({ orgId: "o1", recipients: RECIPIENTS });

    platformIdentityHolder.mockReturnValue(null);
    await expect(unlockIdentityVault("a1")).rejects.toMatchObject({ status: 503 });

    platformIdentityHolder.mockReturnValue("PlatformAddr");
    getAgent.mockResolvedValue({ ...AGENT, nftPlatformAssetAddress: undefined, nftAgentAssetAddress: undefined, nftMintAddress: undefined });
    await expect(unlockIdentityVault("a1")).rejects.toBeInstanceOf(VaultError);

    getAgent.mockResolvedValue(AGENT);
    fetchIdentityCopyOwner.mockImplementation(async (asset: string) => (asset === "PlatAsset" ? "SomeoneElse" : HOLDERS[asset]));
    await expect(unlockIdentityVault("a1")).rejects.toMatchObject({ status: 403 });

    fetchIdentityCopyOwner.mockImplementation(async (asset: string) => (asset === "OwnerAsset" ? "SomeoneElse" : HOLDERS[asset]));
    await expect(unlockIdentityVault("a1")).rejects.toMatchObject({ status: 403 });

    getAgent.mockResolvedValue({ ...AGENT, nftOwnerAssetAddress: undefined, nftOwnerSolanaAddress: undefined });
    fetchIdentityCopyOwner.mockImplementation(async (asset: string) => HOLDERS[asset] ?? null);
    await expect(unlockIdentityVault("a1")).resolves.toEqual({
      orgId: "o1",
      recipients: { protocol: "PlatformAddr", agent: "AgentAddr111", user: null },
    });
  });

  it("stores the three wraps and never the plaintext", async () => {
    const { putIdentityVault, getIdentityVault, listIdentityVault, deleteIdentityVault } = await import("../identity-vault");
    const sealed = box();
    await putIdentityVault("a1", "o1", "memory", sealed, RECIPIENTS);
    const stored = await getIdentityVault("a1", "memory");
    expect(stored?.v).toBe(2);
    expect(stored?.wraps.protocol).toEqual(sealed.wraps.protocol);
    expect(stored?.wraps.agent).toEqual(sealed.wraps.agent);
    expect(stored?.wraps.user).toEqual(sealed.wraps.user);
    expect(JSON.stringify(stored)).not.toContain("couch");
    const listed = await listIdentityVault("a1");
    expect(listed.map((row) => row.slot)).toEqual(["memory"]);
    expect(listed[0].bytes).toBe(32);
    expect(await deleteIdentityVault("a1", "memory")).toBe(true);
    expect(await getIdentityVault("a1", "memory")).toBeNull();
  });

  it("requires the user wrap exactly when copy #2 is minted", async () => {
    const { putIdentityVault, parseVaultSlot, VaultError } = await import("../identity-vault");
    expect(() => parseVaultSlot("Memory")).toThrow(VaultError);
    await expect(putIdentityVault("a1", "o1", "memory", { ...box(), v: 1 }, RECIPIENTS)).rejects.toMatchObject({ status: 400 });
    await expect(putIdentityVault("a1", "o1", "memory", box(null), RECIPIENTS)).rejects.toMatchObject({ status: 400 });
    await expect(putIdentityVault("a1", "o1", "memory", box(), { ...RECIPIENTS, user: null })).rejects.toMatchObject({ status: 400 });
    await expect(putIdentityVault("a1", "o1", "memory", box(null), { ...RECIPIENTS, user: null })).resolves.toBeUndefined();
    await expect(putIdentityVault("a1", "o1", "note", { ...box(), ciphertext: "!!!!" }, RECIPIENTS)).rejects.toMatchObject({ status: 400 });
  });
});
