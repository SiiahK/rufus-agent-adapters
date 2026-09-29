/**
 * Spend authorization bound to principal, tenant, wallet, action, network, budget, nonce and expiry.
 *
 * The repository has no SIWS implementation; this reuses the primitive the protocol already relies on
 * (ed25519 signMessage over a domain-prefixed message, as for `rufus-v2:release:…` approvals), so any
 * Solana wallet that can sign messages can issue it. The signed bytes carry program ID and cluster, so an
 * authorization for devnet/localnet cannot be replayed on mainnet, and tenant/principal membership is
 * checked against the operator-controlled registry, not against claims in the payload.
 */

import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./protocol.js";
import { sortKeys, type Cluster } from "./policy.js";

export type AuthorizedAction = "create_task" | "request_refund" | "submit_evidence";

export interface SpendAuthorizationPayload {
  v: 1;
  domain: "rufus-v2-escrow";
  programId: string;
  cluster: Cluster;
  tenant: string;
  principal: string;       // base58 ed25519 key of the human/org authorizing spend
  wallet: string;          // payer wallet the signer will use
  action: AuthorizedAction;
  budget: { mint: string; maxGrossRaw: string };
  previewDigest?: string;  // binds create_task to one exact preview
  task?: string;           // binds refund/evidence to one task
  nonce: string;           // 32 hex chars
  issuedAt: number;
  expiresAt: number;
}

export interface SpendAuthorization { payload: SpendAuthorizationPayload; signature: string /* base58 */; }

export class AuthorizationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "AuthorizationError"; }
}

export function authorizationMessage(p: SpendAuthorizationPayload): Buffer {
  return Buffer.from(`rufus-v2:authz:${JSON.stringify(sortKeys(p))}`, "utf-8");
}

export function signAuthorization(payload: SpendAuthorizationPayload, principalSecretKey: Uint8Array): SpendAuthorization {
  return { payload, signature: bs58.encode(nacl.sign.detached(authorizationMessage(payload), principalSecretKey)) };
}

/** Operator-controlled registry: which principals may authorize which wallets for a tenant. */
export interface TenantRegistry { principalsFor(tenant: string): { principal: string; wallets: string[] }[]; }

/** Consumes a nonce once; returns false if it was already used. Must be durable in production. */
export interface NonceStore { consume(tenant: string, nonce: string, expiresAt: number): boolean; }

export function memoryNonceStore(): NonceStore {
  const used = new Set<string>();
  return { consume: (t, n) => { const k = `${t}:${n}`; if (used.has(k)) return false; used.add(k); return true; } };
}

export interface ExpectedAuthorization {
  cluster: Cluster;
  wallet: string;
  action: AuthorizedAction;
  mint?: string;
  grossRaw?: bigint;
  previewDigest?: string;
  task?: string;
  now: number;
  maxLifetimeSecs?: number;
}

/** Verifies everything except the nonce, then consumes the nonce last so a rejected request does not burn it. */
export function verifyAuthorization(a: SpendAuthorization, exp: ExpectedAuthorization, registry: TenantRegistry, nonces: NonceStore): SpendAuthorizationPayload {
  const p = a?.payload;
  if (!p || p.v !== 1 || p.domain !== "rufus-v2-escrow") throw new AuthorizationError("malformed", "unsupported authorization payload");
  if (p.programId !== PROGRAM_ID.toBase58()) throw new AuthorizationError("wrong_program", "authorization is for another program");
  if (p.cluster !== exp.cluster) throw new AuthorizationError("wrong_cluster", `authorization is for ${p.cluster}, client is ${exp.cluster}`);
  if (p.action !== exp.action) throw new AuthorizationError("wrong_action", `authorization is for ${p.action}`);
  if (p.wallet !== exp.wallet) throw new AuthorizationError("wrong_wallet", "authorization is for another wallet");
  if (!/^[0-9a-f]{32}$/.test(p.nonce)) throw new AuthorizationError("malformed", "nonce must be 32 hex chars");
  if (!(Number.isInteger(p.issuedAt) && Number.isInteger(p.expiresAt))) throw new AuthorizationError("malformed", "timestamps must be integers");
  if (p.expiresAt <= exp.now) throw new AuthorizationError("expired", "authorization expired");
  if (p.issuedAt > exp.now + 60) throw new AuthorizationError("not_yet_valid", "authorization issued in the future");
  if (p.expiresAt - p.issuedAt > (exp.maxLifetimeSecs ?? 3_600)) throw new AuthorizationError("lifetime", "authorization lifetime too long");

  const members = registry.principalsFor(p.tenant);
  const member = members.find((m) => m.principal === p.principal);
  if (!member) throw new AuthorizationError("wrong_tenant", "principal is not a member of this tenant");
  if (!member.wallets.includes(p.wallet)) throw new AuthorizationError("wallet_not_delegated", "principal may not authorize this wallet");

  if (exp.mint !== undefined && p.budget.mint !== exp.mint) throw new AuthorizationError("wrong_mint", "authorization is for another mint");
  if (exp.grossRaw !== undefined) {
    if (!/^[0-9]{1,20}$/.test(p.budget.maxGrossRaw) || exp.grossRaw > BigInt(p.budget.maxGrossRaw)) {
      throw new AuthorizationError("over_budget", "amount exceeds authorized budget");
    }
  }
  if (exp.previewDigest !== undefined && p.previewDigest !== exp.previewDigest) throw new AuthorizationError("preview_mismatch", "authorization does not match this preview");
  if (exp.task !== undefined && p.task !== exp.task) throw new AuthorizationError("wrong_task", "authorization is for another task");

  let sig: Uint8Array;
  try { sig = bs58.decode(a.signature); } catch { throw new AuthorizationError("bad_signature", "signature is not base58"); }
  let principal: PublicKey;
  try { principal = new PublicKey(p.principal); } catch { throw new AuthorizationError("malformed", "principal is not a public key"); }
  if (sig.length !== 64 || !nacl.sign.detached.verify(authorizationMessage(p), sig, principal.toBytes())) {
    throw new AuthorizationError("bad_signature", "signature does not verify");
  }
  if (!nonces.consume(p.tenant, p.nonce, p.expiresAt)) throw new AuthorizationError("replay", "nonce already used");
  return p;
}
