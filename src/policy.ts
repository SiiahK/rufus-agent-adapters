/**
 * Deterministic agent spend policy. The policy is fixed when the client is constructed; tool inputs,
 * prompts, task descriptions and agent metadata are data and can never widen it.
 */

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { U64_MAX } from "./amounts.js";

export type Cluster = "mainnet-beta" | "devnet" | "localnet";

export const READ_ONLY_TOOLS = ["rufus.preview_task", "rufus.get_task", "rufus.get_receipt"] as const;
export const FINANCIAL_TOOLS = ["rufus.create_task", "rufus.request_refund", "rufus.submit_evidence"] as const;
export type RufusTool = (typeof READ_ONLY_TOOLS)[number] | (typeof FINANCIAL_TOOLS)[number];
export const isFinancialTool = (t: string) => (FINANCIAL_TOOLS as readonly string[]).includes(t);

export interface AgentSpendPolicy {
  version: 1;
  policyId: string;
  cluster: Cluster;
  /** mint → limits, raw units as decimal-integer strings. */
  mints: Record<string, { maxGrossPerTaskRaw: string; budgetRaw: string }>;
  /** Callee allowlist; empty means no financial action is allowed. */
  allowedCallees: string[];
  allowedTools: RufusTool[];
  minDeadlineSecs: number;
  maxDeadlineSecs: number;
}

export class PolicyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PolicyError"; }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.values(o as object).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

const RAW = /^[0-9]{1,20}$/;

/** Validates and freezes a policy; returns it with a digest that previews and receipts reference. */
export function loadPolicy(p: AgentSpendPolicy): Readonly<AgentSpendPolicy> & { digest: string } {
  if (p.version !== 1) throw new PolicyError("policy_version", "unsupported policy version");
  if (!["mainnet-beta", "devnet", "localnet"].includes(p.cluster)) throw new PolicyError("policy_cluster", "invalid cluster");
  for (const [mint, lim] of Object.entries(p.mints)) {
    new PublicKey(mint);
    for (const v of [lim.maxGrossPerTaskRaw, lim.budgetRaw]) {
      if (!RAW.test(v) || BigInt(v) <= 0n || BigInt(v) > U64_MAX) throw new PolicyError("policy_amount", `invalid raw amount for ${mint}`);
    }
    if (BigInt(lim.maxGrossPerTaskRaw) > BigInt(lim.budgetRaw)) throw new PolicyError("policy_amount", "per-task max exceeds budget");
  }
  p.allowedCallees.forEach((c) => new PublicKey(c));
  if (!(p.minDeadlineSecs > 0 && p.maxDeadlineSecs >= p.minDeadlineSecs && p.maxDeadlineSecs <= 30 * 86_400)) {
    throw new PolicyError("policy_deadline", "deadline window must be within (0, 30 days]");
  }
  const digest = createHash("sha256").update(JSON.stringify(sortKeys(p))).digest("hex");
  return deepFreeze({ ...structuredClone(p), digest });
}

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return typeof v === "bigint" ? v.toString() : v;
}

export interface SpendRequest {
  tool: RufusTool;
  cluster: Cluster;
  mint: string;
  callee: string;
  grossRaw: bigint;
  deadlineSecsFromNow: number;
}

/** Pure check: same inputs → same answer. `authorizedSoFarRaw` is the cumulative gross already authorized for the mint. */
export function checkSpend(policy: AgentSpendPolicy, req: SpendRequest, authorizedSoFarRaw: bigint): void {
  if (!policy.allowedTools.includes(req.tool)) throw new PolicyError("tool_not_allowed", `${req.tool} not allowed by policy ${policy.policyId}`);
  if (req.cluster !== policy.cluster) throw new PolicyError("wrong_cluster", `policy is for ${policy.cluster}, request is ${req.cluster}`);
  if (!isFinancialTool(req.tool)) return;
  const lim = policy.mints[req.mint];
  if (!lim) throw new PolicyError("mint_not_allowed", `mint ${req.mint} not allowed`);
  if (!policy.allowedCallees.includes(req.callee)) throw new PolicyError("callee_not_allowed", `callee ${req.callee} not in allowlist`);
  if (req.grossRaw > BigInt(lim.maxGrossPerTaskRaw)) throw new PolicyError("per_task_cap", `gross ${req.grossRaw} > per-task cap ${lim.maxGrossPerTaskRaw}`);
  if (authorizedSoFarRaw + req.grossRaw > BigInt(lim.budgetRaw)) throw new PolicyError("budget_cap", `cumulative ${authorizedSoFarRaw + req.grossRaw} > budget ${lim.budgetRaw}`);
  if (req.deadlineSecsFromNow < policy.minDeadlineSecs || req.deadlineSecsFromNow > policy.maxDeadlineSecs) {
    throw new PolicyError("deadline_window", `deadline must be ${policy.minDeadlineSecs}–${policy.maxDeadlineSecs}s from now`);
  }
}

/**
 * Cumulative authorization counter. Refunds do not reduce it: the fee is retained on refund, so reopening
 * the budget would let repeated create/refund cycles pay unbounded fees.
 */
export interface BudgetTracker {
  authorized(mint: string): bigint;
  /** Atomically adds `gross` for `key` if the result stays ≤ cap; idempotent per key. */
  reserve(key: string, mint: string, gross: bigint, cap: bigint): boolean;
  /** Releases a reservation that was never signed or sent. */
  releaseUnsent(key: string): void;
}

export function memoryBudgetTracker(): BudgetTracker {
  const totals = new Map<string, bigint>();
  const seen = new Map<string, { mint: string; gross: bigint }>();
  return {
    authorized: (mint) => totals.get(mint) ?? 0n,
    reserve(key, mint, gross, cap) {
      const prior = seen.get(key);
      if (prior) return prior.mint === mint && prior.gross === gross;
      const next = (totals.get(mint) ?? 0n) + gross;
      if (next > cap) return false;
      totals.set(mint, next);
      seen.set(key, { mint, gross });
      return true;
    },
    releaseUnsent(key) {
      const prior = seen.get(key);
      if (!prior) return;
      totals.set(prior.mint, (totals.get(prior.mint) ?? 0n) - prior.gross);
      seen.delete(key);
    },
  };
}
