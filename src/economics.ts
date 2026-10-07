/**
 * Is escrow worth its fee for this purchase? Expected-value rule, before risk aversion:
 *
 *   escrow pays off when  p · r · P  >  F + O
 *
 *   P  price (gross, atomic units)          p  probability the provider fails to deliver
 *   r  fraction of the principal recovered on failure (1 = full refund; 0 when the failure cannot be detected,
 *      e.g. a hash-matched but useless output)
 *   F  Select fee = floor(P · feeBps / 10 000), taken at creation, not refunded
 *   O  other incremental cost in the same units (latency, locked capital, network fees)
 *
 * Example: P = 100 USDC, p = 5 %, r = 1, F = 2, O = 0.20 → expected recovery 5 > 2.20 → escrow.
 * With p = 0.2 % the same purchase does not justify the fee.
 */

export interface EscrowEconomicsInput {
  priceRaw: bigint;
  /** Probability of non-delivery, in [0, 1]. */
  failureProbability: number;
  /** Fraction of the principal recovered on failure, in [0, 1] (default 1). */
  recoveryFraction?: number;
  /** Other incremental cost, atomic units (default 0). */
  extraCostRaw?: bigint;
  /** Protocol fee in basis points (default 200, the deployed program's fee). */
  feeBps?: number;
}

export interface EscrowEconomics {
  useEscrow: boolean;
  feeRaw: bigint;
  expectedRecoveryRaw: bigint;
  /** expectedRecovery − fee − extra cost (negative: escrow costs more than it is expected to save). */
  expectedNetRaw: bigint;
  /** Failure probability at which escrow breaks even, given the recovery fraction (Infinity when r = 0). */
  breakEvenFailureProbability: number;
}

const SCALE = 1_000_000n;

export function shouldEscrow(i: EscrowEconomicsInput): EscrowEconomics {
  const r = i.recoveryFraction ?? 1, p = i.failureProbability, bps = i.feeBps ?? 200, extra = i.extraCostRaw ?? 0n;
  if (i.priceRaw <= 0n) throw new RangeError("priceRaw must be positive");
  if (!(p >= 0 && p <= 1) || !(r >= 0 && r <= 1)) throw new RangeError("probabilities must be in [0, 1]");
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError("feeBps must be an integer in [0, 10000]");
  if (extra < 0n) throw new RangeError("extraCostRaw must be >= 0");
  const feeRaw = (i.priceRaw * BigInt(bps)) / 10_000n;
  // Integer math on a 1e-6 grid for p·r, so results are exact and reproducible.
  const pr = BigInt(Math.round(p * r * Number(SCALE)));
  const expectedRecoveryRaw = (i.priceRaw * pr) / SCALE;
  const expectedNetRaw = expectedRecoveryRaw - feeRaw - extra;
  const breakEvenFailureProbability = r === 0 ? Infinity : Number(feeRaw + extra) / (r * Number(i.priceRaw));
  return { useEscrow: expectedNetRaw > 0n, feeRaw, expectedRecoveryRaw, expectedNetRaw, breakEvenFailureProbability };
}
