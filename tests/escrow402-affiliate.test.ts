/**
 * Affiliate routing and escrow-402 without a network (in-memory chain). The full flows — the 50/150 bps
 * split executed on the approved binary, 402 payments and the MCP server — are tested in the main Select
 * repository against a LiteSVM replay of mainnet.
 */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as A from "../src/index.js";
import { mockChain } from "./helpers.js";

const USDC = A.USDC_MINT;

/** In-memory chain with extra accounts (IntegratorConfig, token accounts). */
function chainWith(extra: [PublicKey, Buffer][]) {
  const base = mockChain();
  const m = new Map(extra.map(([k, d]) => [k.toBase58(), d]));
  return { ...base, getAccount: async (a: PublicKey) => (m.has(a.toBase58()) ? { data: m.get(a.toBase58())!, owner: A.PROGRAM_ID, lamports: 1n } : base.getAccount(a)) };
}
function integratorConfig(authority: PublicKey, wallet: PublicKey, mode = 0, active = true): Buffer {
  const b = Buffer.alloc(8 + 32 + 1 + 32 + 1 + 8 + 8 + 8 + 1);
  authority.toBuffer().copy(b, 8); b[40] = mode; wallet.toBuffer().copy(b, 41); b[73] = active ? 1 : 0;
  return b;
}

describe("affiliate from host configuration", () => {
  it("env precedence, invalid keys fail loudly, no payer fallback", () => {
    const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
    expect(A.affiliateFromEnv({ SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY: a, RUFUS_AFFILIATE_PUBKEY: b })).toBe(a);
    expect(A.affiliateFromEnv({ RUFUS_AFFILIATE_PUBKEY: b })).toBe(b);
    expect(A.affiliateFromEnv({})).toBeNull();
    expect(() => A.affiliateFromEnv({ RUFUS_AFFILIATE_PUBKEY: "x" })).toThrow(/not a valid public key/);
  });

  it("routes to a valid DirectWallet integrator; otherwise (absent, unregistered, inactive, other mode, self-referral, no token account) to the treasury", async () => {
    const payer = Keypair.generate().publicKey, auth = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey;
    const ok = chainWith([[A.integratorPda(auth), integratorConfig(auth, wallet)], [A.ata(wallet, USDC), Buffer.alloc(165)]]);
    expect(await A.resolveAffiliate(ok, auth.toBase58(), payer, USDC)).toMatchObject({ kind: "affiliate", commissionWallet: wallet.toBase58() });
    expect(await A.resolveAffiliate(ok, null, payer, USDC)).toMatchObject({ kind: "treasury" });
    expect(await A.resolveAffiliate(ok, Keypair.generate().publicKey.toBase58(), payer, USDC)).toMatchObject({ kind: "treasury", reason: expect.stringMatching(/no IntegratorConfig/) });
    const cases: [Buffer, RegExp][] = [
      [integratorConfig(auth, wallet, 0, false), /inactive/], [integratorConfig(auth, wallet, 1), /not DirectWallet/], [integratorConfig(auth, payer), /self-referral/],
    ];
    for (const [cfg, why] of cases) {
      const c = chainWith([[A.integratorPda(auth), cfg], [A.ata(wallet, USDC), Buffer.alloc(165)], [A.ata(payer, USDC), Buffer.alloc(165)]]);
      expect(await A.resolveAffiliate(c, auth.toBase58(), payer, USDC)).toMatchObject({ kind: "treasury", reason: expect.stringMatching(why) });
    }
    const noAta = chainWith([[A.integratorPda(auth), integratorConfig(auth, wallet)]]);
    expect(await A.resolveAffiliate(noAta, auth.toBase58(), payer, USDC)).toMatchObject({ kind: "treasury", reason: expect.stringMatching(/token account/) });
  });

  it("integratorOnboarding: missing config + token account → two instructions; registered → ready; other mode → blocked", async () => {
    const auth = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey;
    const fresh = await A.integratorOnboarding(chainWith([]), auth);
    expect(fresh).toMatchObject({ status: "needs_setup", commissionWallet: auth.toBase58(), integratorConfig: A.integratorPda(auth).toBase58() });
    expect(fresh.instructions.map((i) => i.programId.toBase58())).toEqual([A.PROGRAM_ID.toBase58(), A.ATA_PROGRAM.toBase58()]);
    const ready = chainWith([[A.integratorPda(auth), integratorConfig(auth, wallet)], [A.ata(wallet, USDC), Buffer.alloc(165)]]);
    expect(await A.integratorOnboarding(ready, auth)).toMatchObject({ status: "ready", commissionWallet: wallet.toBase58(), instructions: [] });
    const other = chainWith([[A.integratorPda(auth), integratorConfig(auth, wallet, 1)]]);
    expect(await A.integratorOnboarding(other, auth)).toMatchObject({ status: "blocked" });
  });
});

describe("escrow-402 (custom handshake, not x402)", () => {
  const terms = { amountRaw: 1_500_000n, mint: USDC.toBase58(), payee: Keypair.generate().publicKey.toBase58(), timeoutSecs: 3600, requestId: "r-1" };
  const get = (h: Record<string, string>) => (n: string) => Object.entries(h).find(([k]) => k.toLowerCase() === n)?.[1];

  it("challenge headers round-trip; other 402s are not ours; wrong program and bad terms are refused", () => {
    const h = A.challengeHeaders(terms);
    expect(h["X-Escrow-Scheme"]).toBe("solana-rufus-v2");
    expect(A.parseChallenge(get(h))).toMatchObject({ amountRaw: 1_500_000n, payee: terms.payee, timeoutSecs: 3600, requestId: "r-1" });
    expect(A.parseChallenge(get({ "X-Payment-Required": "x" }))).toBeNull();
    expect(() => A.parseChallenge(get({ ...h, "X-Escrow-Program": Keypair.generate().publicKey.toBase58() }))).toThrow(/X-Escrow-Program/);
    expect(() => A.parseChallenge(get({ ...h, "X-Escrow-Amount": "1.5" }))).toThrow(/positive integer/);
    expect(() => A.parseChallenge(get({ ...h, "X-Escrow-Timeout": "5" }))).toThrow(/Timeout/);
  });

  it("one challenge → one deterministic task id (a retry cannot charge twice)", () => {
    expect(A.challengeTaskId("https://p/job", terms)).toBe(A.challengeTaskId("https://p/job", terms));
    expect(A.challengeTaskId("https://p/job", terms)).not.toBe(A.challengeTaskId("https://p/job", { ...terms, requestId: "r-2" }));
    expect(A.challengeTaskId("https://p/job", terms)).toMatch(/^e402:[0-9a-f]{40}$/);
  });

  it("escrowFetch returns non-escrow responses untouched", async () => {
    const client = {} as A.RufusEscrowClient;
    const ok = await A.escrowFetch("https://p/a", {}, { client, authorize: async () => null, fetch: (async () => new Response("hi", { status: 200 })) as typeof fetch });
    expect(ok.response.status).toBe(200);
    const foreign = await A.escrowFetch("https://p/b", {}, { client, authorize: async () => null, fetch: (async () => new Response(null, { status: 402 })) as typeof fetch });
    expect(foreign.response.status).toBe(402);
    expect(foreign.escrow).toBeUndefined();
  });

  it("provider check: no task → 402 with terms; unknown task → 402; one request per task store", async () => {
    const chain = mockChain(), used = A.memoryUsedTasks();
    const none = await A.verifyEscrowRequest(chain, () => undefined, terms, used);
    expect(none).toMatchObject({ ok: false, status: 402 });
    expect((none as any).headers["X-Escrow-Payee"]).toBe(terms.payee);
    expect(await A.verifyEscrowRequest(chain, (n) => (n === "x-escrow-task" ? Keypair.generate().publicKey.toBase58() : undefined), terms, used)).toMatchObject({ ok: false, reason: expect.stringMatching(/not found/) });
    expect(await used.claim("t")).toBe(true);
    expect(await used.claim("t")).toBe(false);
  });
});

describe("routing domain", () => {
  it("defaults to payments_v2 (bound into the preview); RUFUS_ROUTING_DOMAIN overrides; an unknown domain blocks the preview", async () => {
    const saved = process.env.RUFUS_ROUTING_DOMAIN;
    try {
      delete process.env.RUFUS_ROUTING_DOMAIN;
      expect(A.resolveRoutingDomain()).toBe("payments_v2");
      process.env.RUFUS_ROUTING_DOMAIN = "m2m";
      expect(A.resolveRoutingDomain()).toBe("m2m");
    } finally { if (saved === undefined) delete process.env.RUFUS_ROUTING_DOMAIN; else process.env.RUFUS_ROUTING_DOMAIN = saved; }
    const base = { cluster: "localnet" as const, tenant: "acme", payer: Keypair.generate().publicKey.toBase58(), callee: Keypair.generate().publicKey.toBase58(), mint: USDC.toBase58(), amount: "1", amountBasis: "gross" as const, deadlineSecs: 3600, verification: { type: "payer_approval" as const }, idempotencyKey: "d-1" };
    const pv = await A.previewTask({ ...base, domain: "payments_v2" }, mockChain());
    expect(pv.binding.domain).toBe("payments_v2");
    expect((await A.previewTask(base, mockChain())).binding.domain).toBeUndefined();     // m2m keeps its old digest shape
    expect((await A.previewTask({ ...base, domain: "nope" }, mockChain())).blocking.join()).toMatch(/not initialized/);
  });
});
