/**
 * Core behavior without a network: fee math (the on-chain formula), amount parsing, preview digest,
 * spend policy and authorization binding. Fee values were also checked against the deployed program
 * in the Rufus monorepo (LiteSVM replay of the approved binary).
 */
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as A from "../src/index.js";
import { NOW, makeClient, mockChain } from "./helpers.js";

const USDC = A.USDC_MINT.toBase58();

describe("fee math", () => {
  it("matches create_task_v2: floor fee inside the gross, 25% affiliate share of the fee", () => {
    expect(A.computeFee(1_000_000n, 200n)).toEqual({ gross: 1_000_000n, totalFee: 20_000n, affiliateFee: 5_000n, protocolFee: 15_000n, net: 980_000n });
    expect(A.computeFee(49n, 200n).totalFee).toBe(0n);
    expect(A.computeFee(50n, 200n).totalFee).toBe(1n);
    expect(A.computeFee(199n, 200n).affiliateFee).toBe(0n);
    expect(A.computeFee(200n, 200n).affiliateFee).toBe(1n);
    expect(A.feeThresholds(200n)).toEqual({ firstNonZeroFeeGross: 50n, firstNonZeroAffiliateGross: 200n });
  });
  it("gross-up is minimal and never under-pays", () => {
    expect(A.grossUpForNet(2_000_000n, 200n)).toBe(2_040_816n);
    for (const net of [1n, 49n, 1_000_000n, 123_456_789n]) {
      const g = A.grossUpForNet(net, 200n);
      expect(A.computeFee(g, 200n).net >= net && (g === 1n || A.computeFee(g - 1n, 200n).net < net)).toBe(true);
    }
  });
  it("amounts are decimal strings, never floats", () => {
    expect(A.parseAmount("1.25", 6)).toBe(1_250_000n);
    for (const bad of ["0", "1e3", "-1", "1.0000001", " 1", "18446744073709.551616"]) expect(() => A.parseAmount(bad, 6)).toThrow();
    expect(A.formatAmount(2_040_816n, 6)).toBe("2.040816");
  });
});

describe("preview → authorization → create", () => {
  const setup = () => {
    const payer = Keypair.generate(), callee = Keypair.generate(), principal = Keypair.generate(), chain = mockChain();
    return { payer, callee, principal, chain, client: makeClient(chain, payer, callee.publicKey, principal) };
  };
  const input = (p: Keypair, c: Keypair, over: Partial<A.PreviewInput> = {}): A.PreviewInput => ({
    cluster: "localnet", tenant: "acme", payer: p.publicKey.toBase58(), callee: c.publicKey.toBase58(), mint: USDC, amount: "1", amountBasis: "gross",
    deadlineSecs: 3600, verification: { type: "payer_approval" }, idempotencyKey: "order-1", ...over,
  });
  const authz = (s: ReturnType<typeof setup>, over: Partial<A.SpendAuthorizationPayload> = {}, signer = s.principal) => A.signAuthorization({
    v: 1, domain: "rufus-v2-escrow", programId: A.PROGRAM_ID.toBase58(), cluster: "localnet", tenant: "acme", principal: signer.publicKey.toBase58(),
    wallet: s.payer.publicKey.toBase58(), action: "create_task", budget: { mint: USDC, maxGrossRaw: "1000000" }, nonce: "a".repeat(32), issuedAt: NOW, expiresAt: NOW + 60, ...over,
  }, signer.secretKey);

  it("preview shows every cost and is bound by a digest", async () => {
    const s = setup();
    const p = await s.client.previewTask(input(s.payer, s.callee));
    expect(p.display).toMatchObject({ payerTransfers: "1", fee: "0.02", calleeReceivesOnRelease: "0.98", feeRetainedOnRefund: "0.02" });
    expect(p.rent).toMatchObject({ taskLamports: "2560320", escrowLamports: "1488440", retainedByTombstoneLamports: "1183640" });
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    const again = await s.client.previewTask(input(s.payer, s.callee));
    expect(again.binding.task).toBe(p.binding.task); // same idempotency key → same task address
  });

  it("refuses tampered previews and unauthorized, mis-bound or replayed authorizations before signing", async () => {
    const s = setup();
    const p = await s.client.previewTask(input(s.payer, s.callee));
    const code = async (pr: Promise<unknown>) => { try { await pr; return "ok"; } catch (e: any) { return e.code ?? e.message; } };
    // The client has no signer here, so any path that passes every check would stop at "no_signer".
    expect(await code(s.client.createTask({ ...p, binding: { ...p.binding, callee: Keypair.generate().publicKey.toBase58() } }, authz(s, { previewDigest: p.digest })))).toBe("no_signer");
    const withSigner = new A.RufusEscrowClient({ ...(s.client as any).o, signer: A.keypairSigner(s.payer), sender: { latestBlockhash: async () => { throw new Error("no send in tests"); } } as any });
    expect(await code(withSigner.createTask({ ...p, binding: { ...p.binding, callee: Keypair.generate().publicKey.toBase58() } }, authz(s, { previewDigest: p.digest })))).toBe("preview_tampered");
    expect(await code(withSigner.createTask(p, authz(s, { previewDigest: p.digest }, Keypair.generate())))).toBe("wrong_tenant");
    expect(await code(withSigner.createTask(p, authz(s, { previewDigest: p.digest, cluster: "mainnet-beta" })))).toBe("wrong_cluster");
    expect(await code(withSigner.createTask(p, authz(s, { previewDigest: p.digest, budget: { mint: USDC, maxGrossRaw: "999999" } })))).toBe("over_budget");
    expect(await code(withSigner.createTask(p, authz(s, { previewDigest: "0".repeat(64) })))).toBe("preview_mismatch");
    expect(await code(withSigner.createTask(p, authz(s, { previewDigest: p.digest, expiresAt: NOW - 1, issuedAt: NOW - 100 })))).toBe("expired");
    const ok = authz(s, { previewDigest: p.digest, nonce: "b".repeat(32) });
    expect(await code(withSigner.createTask(p, ok))).toBe("no send in tests"); // every check passed; stopped at the (fake) sender
    expect(await code(withSigner.createTask(p, ok))).toBe("replay");
    // The RPC failed before signing: the reservation was released, so a fresh authorization can retry.
    expect(await code(withSigner.createTask(p, authz(s, { previewDigest: p.digest, nonce: "c".repeat(32) })))).toBe("no send in tests");
    expect(withSigner["o"].budget.authorized(USDC)).toBe(0n);
  });

  it("policy: callee allowlist, per-task cap and deadline window", () => {
    const pol = A.loadPolicy({ version: 1, policyId: "p", cluster: "localnet", mints: { [USDC]: { maxGrossPerTaskRaw: "1000000", budgetRaw: "2000000" } }, allowedCallees: [Keypair.generate().publicKey.toBase58()], allowedTools: ["rufus.create_task"], minDeadlineSecs: 60, maxDeadlineSecs: 3600 });
    const base = { tool: "rufus.create_task" as const, cluster: "localnet" as const, mint: USDC, callee: pol.allowedCallees[0], grossRaw: 1_000_000n, deadlineSecsFromNow: 600 };
    const code = (f: () => void) => { try { f(); return "ok"; } catch (e: any) { return e.code; } };
    expect(code(() => A.checkSpend(pol, base, 0n))).toBe("ok");
    expect(code(() => A.checkSpend(pol, { ...base, callee: Keypair.generate().publicKey.toBase58() }, 0n))).toBe("callee_not_allowed");
    expect(code(() => A.checkSpend(pol, { ...base, grossRaw: 1_000_001n }, 0n))).toBe("per_task_cap");
    expect(code(() => A.checkSpend(pol, base, 1_500_000n))).toBe("budget_cap");
    expect(code(() => A.checkSpend(pol, { ...base, deadlineSecsFromNow: 7200 }, 0n))).toBe("deadline_window");
    expect(Object.isFrozen(pol)).toBe(true);
  });
});
