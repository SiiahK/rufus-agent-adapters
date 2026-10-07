/**
 * 0.5.0 additions without a network: request binding (requestDigest → boundTaskId), the delivery message the
 * provider signs, and shouldEscrow. The full flows (bound escrowFetch → provider/escrow-gate → signed delivery →
 * optimistic release) are tested in the main Select repository against a LiteSVM replay of mainnet.
 */
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import * as A from "../src/index.js";

const terms = { payee: Keypair.generate().publicKey.toBase58(), mint: A.USDC_MINT.toBase58(), amountRaw: 2_000_000n, timeoutSecs: 3600 };
const base: A.BoundRequest = { method: "POST", pathAndQuery: "/v1/report?id=7", body: '{"q":"x"}' };

describe("request binding", () => {
  it("one request → one digest and one task id; method case and body encoding do not matter", () => {
    const d = A.requestDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(A.requestDigest({ ...base, method: "post", body: new TextEncoder().encode('{"q":"x"}') })).toBe(d);
    expect(A.boundTaskId(d, terms)).toBe(A.boundTaskId(d, terms));
    expect(A.boundTaskId(d, terms)).toMatch(/^e402b:[0-9a-f]{48}$/);
  });

  it("any change to method, path, query, body or request id changes the digest; other terms change the task id", () => {
    const d = A.requestDigest(base);
    for (const r of [{ ...base, method: "PUT" }, { ...base, pathAndQuery: "/v1/report?id=8" }, { ...base, body: '{"q":"y"}' }, { ...base, body: null }, { ...base, requestId: "r-1" }])
      expect(A.requestDigest(r)).not.toBe(d);
    expect(A.boundTaskId(d, { ...terms, amountRaw: 2_000_001n })).not.toBe(A.boundTaskId(d, terms));
    expect(() => A.boundTaskId("nothex", terms)).toThrow(/64 hex/);
  });

  it("pathAndQueryOf ignores the host", () => {
    expect(A.pathAndQueryOf("https://a.example/v1/r?id=7")).toBe("/v1/r?id=7");
    expect(A.pathAndQueryOf("http://10.0.0.1:8402/v1/r?id=7")).toBe("/v1/r?id=7");
    expect(A.pathAndQueryOf("/v1/r")).toBe("/v1/r");
  });

  it("the provider check refuses a task when binding is on and the request is not supplied", async () => {
    const r = await A.verifyEscrowRequest({ getAccount: async () => null, now: async () => 0 } as any, () => undefined, { ...terms, mint: terms.mint }, A.memoryUsedTasks());
    expect(r).toMatchObject({ ok: false, status: 402 });
  });
});

describe("delivery message", () => {
  it("binds program, task, response hash and request digest; verifiable with the provider key", () => {
    const provider = Keypair.generate(), task = Keypair.generate().publicKey;
    const sha = "ab".repeat(32), dig = A.requestDigest(base);
    const m = A.deliveryMessage(task, sha, dig);
    expect(m.toString()).toBe(`rufus-v2:delivery:${A.PROGRAM_ID.toBase58()}:${task.toBase58()}:${sha}:${dig}`);
    const sig = nacl.sign.detached(m, provider.secretKey);
    expect(nacl.sign.detached.verify(m, sig, provider.publicKey.toBytes())).toBe(true);
    expect(nacl.sign.detached.verify(A.deliveryMessage(task, "cd".repeat(32), dig), sig, provider.publicKey.toBytes())).toBe(false);
  });
});

describe("shouldEscrow (p·r·P > F + O)", () => {
  it("matches the worked example and the low-failure counter-example", () => {
    const usd = (n: number) => BigInt(Math.round(n * 1e6));
    const e = A.shouldEscrow({ priceRaw: usd(100), failureProbability: 0.05, extraCostRaw: usd(0.2) });
    expect(e).toMatchObject({ useEscrow: true, feeRaw: usd(2), expectedRecoveryRaw: usd(5), expectedNetRaw: usd(2.8) });
    expect(e.breakEvenFailureProbability).toBeCloseTo(0.022, 6);
    expect(A.shouldEscrow({ priceRaw: usd(100), failureProbability: 0.002, extraCostRaw: usd(0.2) }).useEscrow).toBe(false);
    expect(A.shouldEscrow({ priceRaw: usd(100), failureProbability: 0.5, recoveryFraction: 0 })).toMatchObject({ useEscrow: false, breakEvenFailureProbability: Infinity });
    expect(() => A.shouldEscrow({ priceRaw: 0n, failureProbability: 0.1 })).toThrow(RangeError);
    expect(() => A.shouldEscrow({ priceRaw: 1n, failureProbability: 1.5 })).toThrow(RangeError);
  });
});
