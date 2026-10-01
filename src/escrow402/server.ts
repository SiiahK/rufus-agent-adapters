/**
 * Provider side of escrow-402: a route answers 402 with escrow terms until the request carries
 * X-Escrow-Task for a funded task that pays this provider at least the price, in the right mint, with enough
 * time left before its deadline. Each task unlocks one request (replay → 409). The task account is read from
 * the chain; X-Escrow-Tx is informational only. Settlement stays with the executor and the payer's approval.
 *
 * Framework adapters are structural (no express/hono dependency): expressEscrow() and honoEscrow().
 */

import { PublicKey } from "@solana/web3.js";
import type { ChainReader } from "../chain.js";
import { PROGRAM_ID, TaskStatus, decodeTask } from "../protocol.js";
import { challengeHeaders, type EscrowTerms } from "./protocol.js";

export interface UsedTaskStore { claim(task: string): boolean | Promise<boolean> }
export function memoryUsedTasks(): UsedTaskStore { const s = new Set<string>(); return { claim: (t) => (s.has(t) ? false : (s.add(t), true)) }; }

export interface ProviderTerms extends Omit<EscrowTerms, "requestId"> {
  /** Minimum seconds that must remain before the task deadline when the request is served (default 60). */
  minTimeLeftSecs?: number;
}

export type EscrowCheck =
  | { ok: true; task: string; payer: string; grossRaw: string; deadline: number }
  | { ok: false; status: 402 | 409; reason: string; headers: Record<string, string> };

export async function verifyEscrowRequest(chain: ChainReader, getHeader: (n: string) => string | null | undefined, terms: ProviderTerms, used: UsedTaskStore, requestId?: string): Promise<EscrowCheck> {
  const challenge = challengeHeaders({ ...terms, requestId });
  const deny = (reason: string, status: 402 | 409 = 402): EscrowCheck => ({ ok: false, status, reason, headers: challenge });
  const raw = getHeader("x-escrow-task");
  if (!raw) return deny("payment required: fund an escrow task with these terms and retry with X-Escrow-Task");
  let key: PublicKey;
  try { key = new PublicKey(raw); } catch { return deny("X-Escrow-Task is not a public key"); }
  const acct = await chain.getAccount(key);
  if (!acct || !acct.owner.equals(PROGRAM_ID)) return deny("escrow task not found on-chain");
  let t;
  try { t = decodeTask(acct.data); } catch { return deny("account is not a live escrow task"); }
  if (t.status !== TaskStatus.Funded && t.status !== TaskStatus.Active) return deny(`escrow task is ${TaskStatus[t.status]}`);
  if (t.calleeAgent.toBase58() !== new PublicKey(terms.payee).toBase58()) return deny("escrow task does not pay this provider");
  if (t.escrowMint.toBase58() !== terms.mint) return deny("escrow task uses another mint");
  const gross = t.escrowAmount + t.protocolFee + t.affiliateFee;
  if (gross < terms.amountRaw) return deny("escrow task amount is below the price");
  const now = await chain.now();
  if (Number(t.deadline) - now < (terms.minTimeLeftSecs ?? 60)) return deny("escrow task deadline is too close");
  if (!(await used.claim(key.toBase58()))) return deny("escrow task already used for another request", 409);
  return { ok: true, task: key.toBase58(), payer: t.payer.toBase58(), grossRaw: gross.toString(), deadline: Number(t.deadline) };
}

/** Express-compatible middleware: (req, res, next). Sets req.escrow on success. */
export function expressEscrow(o: { chain: ChainReader; terms: ProviderTerms; used?: UsedTaskStore }) {
  const used = o.used ?? memoryUsedTasks();
  return async (req: any, res: any, next: (e?: unknown) => void) => {
    try {
      const v = await verifyEscrowRequest(o.chain, (n) => req.get?.(n) ?? req.headers?.[n.toLowerCase()], o.terms, used, req.get?.("x-request-id") ?? undefined);
      if (v.ok) { req.escrow = v; return next(); }
      res.status(v.status).set(v.headers).json({ error: "escrow_required", reason: v.reason });
    } catch (e) { next(e); }
  };
}

/** Hono-compatible middleware: async (c, next). Sets c.var.escrow on success. */
export function honoEscrow(o: { chain: ChainReader; terms: ProviderTerms; used?: UsedTaskStore }) {
  const used = o.used ?? memoryUsedTasks();
  return async (c: any, next: () => Promise<void>) => {
    const v = await verifyEscrowRequest(o.chain, (n) => c.req.header(n), o.terms, used, c.req.header("x-request-id") ?? undefined);
    if (v.ok) { c.set("escrow", v); await next(); return; }
    return c.json({ error: "escrow_required", reason: v.reason }, v.status, v.headers);
  };
}
