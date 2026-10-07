/**
 * Client side of escrow-402: wraps fetch. On an escrow-402 challenge it funds a task through
 * RufusEscrowClient.createTaskEscrow — so the spend policy (allowed payees, per-task and cumulative caps,
 * deadlines) and the host's authorize() callback apply — then retries once with the task address.
 *
 * Safety rules:
 *  - a server can never make the client pay without host authorization, nor above policy;
 *  - the task is bound to this exact request (method, path+query, body, request id) and terms: a retry of the same
 *    request reuses the task and cannot charge twice, and the provider rejects the task for any other request;
 *  - a server-suggested affiliate is ignored unless the host opts in (it would only redirect the
 *    treasury's share, but the host decides who earns the commission);
 *  - payment happens before delivery; release is a separate payer approval (releaseTaskEscrow).
 */

import { createHash } from "node:crypto";
import { formatAmount } from "../amounts.js";
import { ClientError, type HostAuthorize, type RufusEscrowClient } from "../client.js";
import { SETTLEABLE_MINTS, TaskStatus } from "../protocol.js";
import { Escrow402Error, boundTaskId, parseChallenge, pathAndQueryOf, requestDigest, type EscrowTerms } from "./protocol.js";

export interface EscrowFetchOptions {
  client: RufusEscrowClient;
  authorize: HostAuthorize;
  fetch?: typeof fetch;
  tenant?: string;
  /** Accept X-Escrow-Affiliate from the server (default false: the host's own affiliate setting applies). */
  acceptServerAffiliate?: boolean;
}

export interface EscrowFetchResult {
  response: Response;
  escrow?: { task: string; signature?: string; state: string; terms: EscrowTerms; commission?: unknown };
}

const bodyIsReplayable = (b: unknown) => b === undefined || b === null || typeof b === "string" || b instanceof Uint8Array || b instanceof ArrayBuffer || b instanceof URLSearchParams;
const bodyForDigest = (b: unknown): Uint8Array | string | null =>
  b == null ? null : typeof b === "string" ? b : b instanceof URLSearchParams ? b.toString() : b instanceof ArrayBuffer ? new Uint8Array(b) : (b as Uint8Array);

/** @deprecated since 0.5.0: unbound (URL + terms only). escrowFetch uses boundTaskId(requestDigest(...)). */
export function challengeTaskId(url: string, t: EscrowTerms): string {
  const h = createHash("sha256").update(JSON.stringify([url, t.requestId ?? null, t.payee, t.mint, t.amountRaw.toString(), t.timeoutSecs])).digest("hex");
  return `e402:${h.slice(0, 40)}`;
}

export async function escrowFetch(input: string | URL, init: RequestInit = {}, o: EscrowFetchOptions): Promise<EscrowFetchResult> {
  const f = o.fetch ?? fetch;
  if (!bodyIsReplayable(init.body)) throw new Escrow402Error("body_not_replayable", "escrowFetch needs a string/bytes body so the request can be retried after funding");
  const first = await f(input, init);
  if (first.status !== 402) return { response: first };
  const terms = parseChallenge((n) => first.headers.get(n));
  if (!terms) return { response: first };                       // a 402 that is not ours: hand it back untouched
  const meta = SETTLEABLE_MINTS[terms.mint];
  if (!meta) throw new Escrow402Error("mint_not_settleable", "X-Escrow-Mint is not settleable by the program");
  const url = typeof input === "string" ? input : input.toString();
  const tenant = o.tenant ?? o.client.defaultTenant;
  const digest = requestDigest({ method: init.method ?? "GET", pathAndQuery: pathAndQueryOf(url), body: bodyForDigest(init.body), requestId: terms.requestId });
  const taskId = boundTaskId(digest, terms);
  const bind = (h: Headers, task: string) => { h.set("X-Escrow-Task", task); h.set("X-Escrow-Tenant", tenant); h.set("X-Escrow-Request-Digest", digest); };
  // Same request seen before (retry, crash, lost response): reuse the task if it is still funded for this payee.
  const existing = await o.client.getTask(o.client.taskAddress(taskId, tenant));
  if (existing.onChain.kind === "task") {
    const t = existing.onChain.task;
    if (t.calleeAgent.toBase58() !== terms.payee || t.escrowMint.toBase58() !== terms.mint || t.escrowAmount + t.protocolFee + t.affiliateFee < terms.amountRaw || (t.status !== TaskStatus.Funded && t.status !== TaskStatus.Active)) {
      throw new Escrow402Error("task_conflict", `existing escrow task ${existing.task} does not match these terms or is no longer funded`);
    }
    const headers = new Headers(init.headers);
    bind(headers, existing.task);
    return { response: await f(input, { ...init, headers }), escrow: { task: existing.task, state: "reused", terms } };
  }
  if (existing.onChain.kind === "tombstone") throw new Escrow402Error("task_closed", `escrow task ${existing.task} for this challenge is already closed`);
  const created = await o.client.createTaskEscrow({
    amount: formatAmount(terms.amountRaw, meta.decimals), taskId, providerPubkey: terms.payee, timeoutSeconds: terms.timeoutSecs,
    mint: terms.mint, tenant, authorize: o.authorize,
    ...(o.acceptServerAffiliate && terms.affiliate ? { affiliatePubkey: terms.affiliate } : {}),
  });
  if (created.state === "failed_final" || created.state === "cancelled_before_send") throw new ClientError("escrow_not_funded", `escrow task ${created.task} was not funded (${created.state})`);
  const headers = new Headers(init.headers);
  bind(headers, created.task);
  if (created.signature) headers.set("X-Escrow-Tx", created.signature);
  const second = await f(input, { ...init, headers });
  return { response: second, escrow: { task: created.task, signature: created.signature, state: created.state, terms, commission: created.commission } };
}
