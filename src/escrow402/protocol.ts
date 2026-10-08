/**
 * escrow-402: a custom HTTP 402 handshake for asynchronous AI tasks paid through Select Escrow v2.
 *
 * It is NOT x402 and not x402-conformant: a standard x402 client does not understand these headers, and no
 * x402 payment is accepted or produced. The provider answers 402 with the terms below; the client funds an
 * escrow task (policy + host authorization) and retries with the task address. Funds are released later by
 * the registered executor on the payer's approval (or refunded), so the request is not "paid" on delivery.
 *
 *   402 response      X-Escrow-Scheme: solana-rufus-v2      X-Escrow-Program: <program id>
 *                     X-Escrow-Amount: <atomic units, integer>   X-Escrow-Mint: <mint> (default USDC)
 *                     X-Escrow-Payee: <provider wallet>     X-Escrow-Timeout: <seconds>
 *                     X-Escrow-Request-Id: <id> (optional)  X-Escrow-Affiliate: <integrator> (optional, ignored by default)
 *   retry request     X-Escrow-Task: <task address>         X-Escrow-Tx: <create signature>
 *                     X-Escrow-Tenant: <tenant used to derive the task>
 *
 * Request binding (since 0.5.0): the task's idempotency key is derived from a digest of the request itself
 * (method, path+query, SHA-256 of the body, request id) and the terms. The provider recomputes that digest from
 * the request it actually received and checks that the task's on-chain client_operation_id matches, so a funded
 * task unlocks exactly one request shape: another body, path or method needs another task.
 */

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, USDC_MINT } from "../protocol.js";
import { U64_MAX } from "../amounts.js";

export const ESCROW_402_SCHEME = "solana-rufus-v2";

export interface EscrowTerms {
  amountRaw: bigint;
  mint: string;
  payee: string;
  timeoutSecs: number;
  requestId?: string;
  affiliate?: string;
}

export class Escrow402Error extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "Escrow402Error"; }
}

type HeaderGetter = (name: string) => string | null | undefined;

const pk = (v: string, field: string) => { try { return new PublicKey(v).toBase58(); } catch { throw new Escrow402Error("bad_terms", `${field} is not a public key`); } };

/** Parses a 402 challenge. Returns null when the response is not an escrow-402 challenge for this program. */
export function parseChallenge(get: HeaderGetter): EscrowTerms | null {
  if (get("x-escrow-scheme") !== ESCROW_402_SCHEME) return null;
  if (get("x-escrow-program") !== PROGRAM_ID.toBase58()) throw new Escrow402Error("wrong_program", "X-Escrow-Program is not the Select Escrow v2 program");
  const amount = get("x-escrow-amount") ?? "";
  if (!/^[1-9][0-9]{0,19}$/.test(amount) || BigInt(amount) > U64_MAX) throw new Escrow402Error("bad_terms", "X-Escrow-Amount must be a positive integer of atomic units");
  const timeout = Number(get("x-escrow-timeout") ?? "");
  if (!Number.isInteger(timeout) || timeout < 60 || timeout > 30 * 86_400) throw new Escrow402Error("bad_terms", "X-Escrow-Timeout must be an integer in [60, 2592000]");
  const requestId = get("x-escrow-request-id") ?? undefined;
  if (requestId !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(requestId)) throw new Escrow402Error("bad_terms", "X-Escrow-Request-Id has invalid characters");
  const aff = get("x-escrow-affiliate");
  return {
    amountRaw: BigInt(amount), mint: pk(get("x-escrow-mint") ?? USDC_MINT.toBase58(), "X-Escrow-Mint"), payee: pk(get("x-escrow-payee") ?? "", "X-Escrow-Payee"),
    timeoutSecs: timeout, requestId, affiliate: aff ? pk(aff, "X-Escrow-Affiliate") : undefined,
  };
}

/** Headers a provider sends with its 402 response. */
export function challengeHeaders(t: EscrowTerms): Record<string, string> {
  const h: Record<string, string> = {
    "X-Escrow-Scheme": ESCROW_402_SCHEME, "X-Escrow-Program": PROGRAM_ID.toBase58(), "X-Escrow-Amount": t.amountRaw.toString(),
    "X-Escrow-Mint": t.mint, "X-Escrow-Payee": t.payee, "X-Escrow-Timeout": String(t.timeoutSecs),
  };
  if (t.requestId) h["X-Escrow-Request-Id"] = t.requestId;
  if (t.affiliate) h["X-Escrow-Affiliate"] = t.affiliate;
  return h;
}

export const ESCROW_402_BINDING = "select-escrow402-request-v1";

export interface BoundRequest {
  method: string;
  /** Path and query as sent, e.g. "/v1/report?id=7". The host is excluded (it differs behind proxies). */
  pathAndQuery: string;
  body?: Uint8Array | string | null;
  requestId?: string;
}

const bodyBytes = (b: BoundRequest["body"]) => (b == null ? new Uint8Array() : typeof b === "string" ? new TextEncoder().encode(b) : b);

/** Canonical digest of one request (JSON array with fixed field order, body hashed separately). */
export function requestDigest(r: BoundRequest): string {
  const bodyHash = createHash("sha256").update(bodyBytes(r.body)).digest("hex");
  return createHash("sha256").update(JSON.stringify([ESCROW_402_BINDING, r.method.toUpperCase(), r.pathAndQuery, bodyHash, r.requestId ?? null])).digest("hex");
}

/** Idempotency key of the task that pays for exactly this request under these terms. */
export function boundTaskId(digest: string, t: Pick<EscrowTerms, "payee" | "mint" | "amountRaw" | "timeoutSecs">): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Escrow402Error("bad_digest", "request digest must be 64 hex characters");
  const h = createHash("sha256").update(JSON.stringify([digest, t.payee, t.mint, t.amountRaw.toString(), t.timeoutSecs])).digest("hex");
  return `e402b:${h.slice(0, 48)}`;
}

/** "/path?query" of a URL string (absolute or relative). */
export function pathAndQueryOf(url: string): string {
  const u = new URL(url, "http://binding.invalid");
  return `${u.pathname}${u.search}`;
}
