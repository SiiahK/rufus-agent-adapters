/**
 * Integrator (affiliate) commission routing.
 *
 * The program pays 25% of the creation fee (50 of the 200 bps) to a third party only when create_task_v2
 * carries a registered DirectWallet IntegratorConfig AND a token account of its commission wallet.
 * Otherwise the whole fee goes to the treasury. This module decides, from host configuration only, whether a
 * creation can carry an affiliate:
 *
 *  - source: explicit host option, else SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY, else RUFUS_AFFILIATE_PUBKEY;
 *  - the key must be the authority of an IntegratorConfig owned by the program, active and DirectWallet;
 *  - its commission token account must exist for the task mint;
 *  - it must not route the commission back to the payer (self-referral). There is deliberately NO fallback
 *    to the payer's key: without a valid affiliate the share stays with the treasury.
 *
 * Agent/tool input never reaches this module; only the host that builds the client chooses the affiliate.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { ChainReader } from "./chain.js";
import { ATA_PROGRAM, PROGRAM_ID, TOKEN_PROGRAM, USDC_MINT, ata, buildRegisterIntegratorIx, integratorPda } from "./protocol.js";

export const AFFILIATE_ENV_VARS = ["SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY", "RUFUS_AFFILIATE_PUBKEY"] as const;

export class AffiliateConfigError extends Error {
  constructor(message: string) { super(message); this.name = "AffiliateConfigError"; }
}

/** First non-empty variable wins. An invalid key is a configuration error (fail loudly, not silently to treasury). */
export function affiliateFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  for (const k of AFFILIATE_ENV_VARS) {
    const v = env[k]?.trim();
    if (!v) continue;
    try { return new PublicKey(v).toBase58(); } catch { throw new AffiliateConfigError(`${k} is not a valid public key`); }
  }
  return null;
}

export interface IntegratorConfigView { authority: string; referralMode: number; commissionWallet: string; active: boolean }

/** IntegratorConfig (state.rs): disc 8 | authority 32 | referral_mode 1 | commission_wallet 32 | active 1 | … */
export function decodeIntegratorConfig(data: Buffer): IntegratorConfigView {
  if (data.length < 74) throw new Error("short IntegratorConfig");
  return { authority: new PublicKey(data.subarray(8, 40)).toBase58(), referralMode: data[40], commissionWallet: new PublicKey(data.subarray(41, 73)).toBase58(), active: data[73] === 1 };
}

export type AffiliateRoute =
  | { kind: "affiliate"; authority: string; integratorConfig: PublicKey; commissionWallet: string; affiliateTokenAccount: PublicKey }
  | { kind: "treasury"; reason: string };

/** Decides where the 25% share goes for one creation. Read-only. */
export async function resolveAffiliate(chain: ChainReader, authority: string | null, payer: PublicKey, mint: PublicKey): Promise<AffiliateRoute> {
  if (!authority) return { kind: "treasury", reason: "no affiliate configured" };
  let auth: PublicKey;
  try { auth = new PublicKey(authority); } catch { return { kind: "treasury", reason: "affiliate is not a public key" }; }
  const cfgKey = integratorPda(auth);
  const acct = await chain.getAccount(cfgKey);
  if (!acct || !acct.owner.equals(PROGRAM_ID)) return { kind: "treasury", reason: "affiliate has no IntegratorConfig on this cluster" };
  let v: IntegratorConfigView;
  try { v = decodeIntegratorConfig(acct.data); } catch { return { kind: "treasury", reason: "IntegratorConfig unreadable" }; }
  if (!v.active) return { kind: "treasury", reason: "affiliate IntegratorConfig is inactive" };
  if (v.referralMode !== 0) return { kind: "treasury", reason: "affiliate is not DirectWallet" };
  if (v.commissionWallet === payer.toBase58() || auth.equals(payer)) return { kind: "treasury", reason: "affiliate would route the commission to the payer (self-referral)" };
  const tokenAccount = ata(new PublicKey(v.commissionWallet), mint);
  if (!(await chain.getAccount(tokenAccount))) return { kind: "treasury", reason: "affiliate commission token account does not exist for this mint" };
  return { kind: "affiliate", authority: auth.toBase58(), integratorConfig: cfgKey, commissionWallet: v.commissionWallet, affiliateTokenAccount: tokenAccount };
}

// ── Integrator onboarding (the integrator's own side) ───────

/** create_associated_token_account_idempotent: a no-op when the account already exists. */
export function buildCreateAtaIdempotentIx(funder: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export interface IntegratorOnboarding {
  authority: string; integratorConfig: string; commissionWallet: string; commissionTokenAccount: string;
  /** ready: hosts can set this authority as their affiliate now; needs_setup: sign `instructions` first; blocked: cannot earn (see reason). */
  status: "ready" | "needs_setup" | "blocked";
  reason?: string;
  /** Signed by the authority (who also pays rent ≈ 0.00118 SOL for the config, ≈ 0.00149 SOL for a new token account). */
  instructions: TransactionInstruction[];
}

/**
 * What an integrator (agent platform, framework, marketplace) needs on-chain to earn 25% of the fee (50 bps)
 * on the tasks its users create: a DirectWallet IntegratorConfig (PDA "integrator_v1" + authority) and a token
 * account of its commission wallet for the task mint. Read-only; returns the missing instructions.
 * The IntegratorConfig is init-once: an existing one keeps its commission wallet and mode.
 */
export async function integratorOnboarding(chain: ChainReader, authority: PublicKey, commissionWallet: PublicKey = authority, mint: PublicKey = USDC_MINT): Promise<IntegratorOnboarding> {
  const cfgKey = integratorPda(authority), acct = await chain.getAccount(cfgKey);
  const ixs: TransactionInstruction[] = [];
  let wallet = commissionWallet;
  if (acct) {
    if (!acct.owner.equals(PROGRAM_ID)) throw new Error("integrator PDA is not owned by the program");
    const v = decodeIntegratorConfig(acct.data);
    wallet = new PublicKey(v.commissionWallet);
    const base = { authority: authority.toBase58(), integratorConfig: cfgKey.toBase58(), commissionWallet: v.commissionWallet, commissionTokenAccount: ata(wallet, mint).toBase58(), instructions: [] };
    if (!v.active) return { ...base, status: "blocked", reason: "IntegratorConfig is inactive" };
    if (v.referralMode !== 0) return { ...base, status: "blocked", reason: "IntegratorConfig is not DirectWallet (init-once: use another authority)" };
  } else ixs.push(buildRegisterIntegratorIx(authority, wallet));
  const tokenAccount = ata(wallet, mint);
  if (!(await chain.getAccount(tokenAccount))) ixs.push(buildCreateAtaIdempotentIx(authority, wallet, mint));
  return { authority: authority.toBase58(), integratorConfig: cfgKey.toBase58(), commissionWallet: wallet.toBase58(), commissionTokenAccount: tokenAccount.toBase58(), status: ixs.length ? "needs_setup" : "ready", instructions: ixs };
}
