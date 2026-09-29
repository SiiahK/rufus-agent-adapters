/**
 * Token amounts: decimal strings at the API boundary, bigint internally. Never Number/float.
 * Fee math reproduces create_task_v2 exactly (integer floor division, fee inside the gross amount).
 */

import { AFFILIATE_SHARE_OF_FEE_BPS, BPS_DENOMINATOR } from "./protocol.js";

export const U64_MAX = (1n << 64n) - 1n;

export class AmountError extends Error {
  constructor(message: string) { super(message); this.name = "AmountError"; }
}

/** Parses "1.25" with at most `decimals` fractional digits into raw units. Rejects signs, exponents, spaces and > u64. */
export function parseAmount(value: string, decimals: number): bigint {
  if (typeof value !== "string") throw new AmountError("amount must be a decimal string");
  if (value.length === 0 || value.length > 32) throw new AmountError("amount length out of range");
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!m) throw new AmountError(`invalid decimal amount "${value}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new AmountError(`more than ${decimals} decimal places`);
  const raw = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (raw <= 0n) throw new AmountError("amount must be positive");
  if (raw > U64_MAX) throw new AmountError("amount exceeds u64");
  return raw;
}

/** Raw units → canonical decimal string (no trailing zeros beyond one integer digit). */
export function formatAmount(raw: bigint, decimals: number): string {
  if (raw < 0n) throw new AmountError("negative amount");
  const base = 10n ** BigInt(decimals);
  const int = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int.toString();
}

export interface FeeBreakdown {
  gross: bigint;          // amount the payer transfers at creation
  totalFee: bigint;       // floor(gross × feeBps / 10000)
  affiliateFee: bigint;   // floor(totalFee × 2500 / 10000)
  protocolFee: bigint;    // totalFee − affiliateFee
  net: bigint;            // held in escrow; what the callee receives on release, or the payer on refund
}

export function computeFee(gross: bigint, feeBps: bigint): FeeBreakdown {
  if (gross <= 0n || gross > U64_MAX) throw new AmountError("gross must be in (0, u64]");
  if (feeBps < 0n || feeBps > BPS_DENOMINATOR) throw new AmountError("fee bps out of range");
  const totalFee = (gross * feeBps) / BPS_DENOMINATOR;
  const affiliateFee = (totalFee * AFFILIATE_SHARE_OF_FEE_BPS) / BPS_DENOMINATOR;
  return { gross, totalFee, affiliateFee, protocolFee: totalFee - affiliateFee, net: gross - totalFee };
}

/** Smallest gross whose net (after the on-chain fee) is at least `net`. */
export function grossUpForNet(net: bigint, feeBps: bigint): bigint {
  if (net <= 0n) throw new AmountError("net must be positive");
  const denom = BPS_DENOMINATOR - feeBps;
  let gross = (net * BPS_DENOMINATOR + denom - 1n) / denom;
  while (gross > 1n && computeFee(gross - 1n, feeBps).net >= net) gross -= 1n;
  while (computeFee(gross, feeBps).net < net) gross += 1n;
  return gross;
}

/** Smallest gross at which the fee (and the affiliate share) becomes non-zero, for documentation and preview warnings. */
export function feeThresholds(feeBps: bigint) {
  if (feeBps === 0n) return { firstNonZeroFeeGross: null, firstNonZeroAffiliateGross: null };
  const firstFee = (BPS_DENOMINATOR + feeBps - 1n) / feeBps;                       // floor(g×bps/1e4) ≥ 1
  const minFeeForAffiliate = (BPS_DENOMINATOR + AFFILIATE_SHARE_OF_FEE_BPS - 1n) / AFFILIATE_SHARE_OF_FEE_BPS; // 4
  const firstAff = (minFeeForAffiliate * BPS_DENOMINATOR + feeBps - 1n) / feeBps;
  return { firstNonZeroFeeGross: firstFee, firstNonZeroAffiliateGross: firstAff };
}
