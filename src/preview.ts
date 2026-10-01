/**
 * previewTask: every cost the payer commits to, derived from the live ProtocolConfig and the fee
 * formula of create_task_v2, with a version, an expiry and a digest over the binding parameters.
 */

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { computeFee, feeThresholds, formatAmount, grossUpForNet, parseAmount, U64_MAX } from "./amounts.js";
import type { ChainReader } from "./chain.js";
import { sortKeys, type Cluster } from "./policy.js";
import {
  DEFAULT_DOMAIN, PROGRAM_ID, RENT_LAMPORTS, SETTLEABLE_MINTS, VerificationType, ata, configPda, decodeProtocolConfig,
  integratorPda, riskBudgetPda, routingPda, taskPda, TREASURY_AUTHORITY,
} from "./protocol.js";

export const PREVIEW_VERSION = "rufus.preview.v1";
export const PREVIEW_TTL_SECS = 300;
/** Worker waits this long after the deadline before refunding (V2_REFUND_GRACE_SECS on the live worker). */
export const WORKER_REFUND_GRACE_SECS = 120;

export interface PreviewInput {
  cluster: Cluster;
  tenant: string;
  payer: string;
  callee: string;
  mint: string;
  /** Decimal string. `gross` = amount transferred at creation; `net` = amount the callee should receive (grossed up). */
  amount: string;
  amountBasis: "gross" | "net";
  deadlineSecs: number;
  verification: { type: "payer_approval" } | { type: "artifact_hash"; sha256: string };
  /** Stable economic identity chosen by the caller (1–128 chars). Same key → same task address → no second charge. */
  idempotencyKey: string;
  /** Routing domain (default "m2m" for this pure function; the client and servers pass their configured domain). */
  domain?: string;
  priorityFeeMicroLamports?: number;
  computeUnitLimit?: number;
}

export interface WorkerPolicy { allowedMints: string[]; maxGrossAmountRaw: string | null; }

export interface TaskPreview {
  version: typeof PREVIEW_VERSION;
  binding: {
    cluster: Cluster; programId: string; tenant: string; payer: string; callee: string; mint: string;
    grossRaw: string; deadline: number; verificationType: VerificationType; verificationData: string;
    clientOperationId: string; task: string; feeBps: string; computeUnitLimit: number; priorityFeeMicroLamports: number;
    integratorRegistrationRequired: boolean;
    /** Present only for a non-default routing domain (keeps digests of "m2m" previews unchanged). */
    domain?: string;
  };
  display: {
    symbol: string; decimals: number;
    principalRequested: string; payerTransfers: string; fee: string; protocolFee: string; affiliateFee: string; calleeReceivesOnRelease: string;
    payerReceivesOnRefund: string; feeRetainedOnRefund: string; feeDestination: string;
  };
  rent: {
    taskLamports: string; escrowLamports: string; tombstoneLamports: string; integratorLamports: string;
    lockedAtCreateLamports: string; returnedToPayerOnCloseLamports: string; retainedByTombstoneLamports: string;
    note: string;
  };
  networkFees: { signatures: number; baseFeeLamports: string; maxPriorityFeeLamports: string };
  rules: { refund: string; evidence: string; finality: string };
  warnings: string[];
  blocking: string[];
  createdAt: number;
  expiresAt: number;
  digest: string;
}

export class PreviewError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PreviewError"; }
}

const IDEMPOTENCY = /^[A-Za-z0-9._:-]{1,128}$/;

export function clientOperationId(tenant: string, payer: string, idempotencyKey: string): Buffer {
  return createHash("sha256").update(`rufus-v2:opid:v1:${tenant}:${payer}:${idempotencyKey}`).digest();
}

export const bindingDigest = (b: TaskPreview["binding"], createdAt: number, expiresAt: number) =>
  createHash("sha256").update(JSON.stringify(sortKeys({ version: PREVIEW_VERSION, b, createdAt, expiresAt }))).digest("hex");

function pubkey(v: string, field: string): PublicKey {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) throw new PreviewError("invalid_input", `${field} is not a public key`);
  try { return new PublicKey(v); } catch { throw new PreviewError("invalid_input", `${field} is not a public key`); }
}

export async function previewTask(input: PreviewInput, chain: ChainReader, opts: { workerPolicy?: WorkerPolicy | null } = {}): Promise<TaskPreview> {
  if (!["mainnet-beta", "devnet", "localnet"].includes(input.cluster)) throw new PreviewError("invalid_input", "invalid cluster");
  if (typeof input.tenant !== "string" || !/^[a-z0-9-]{1,64}$/.test(input.tenant)) throw new PreviewError("invalid_input", "tenant must match [a-z0-9-]{1,64}");
  if (!IDEMPOTENCY.test(input.idempotencyKey ?? "")) throw new PreviewError("invalid_input", "idempotencyKey must match [A-Za-z0-9._:-]{1,128}");
  const payer = pubkey(input.payer, "payer");
  const callee = pubkey(input.callee, "callee");
  const mint = pubkey(input.mint, "mint");
  if (callee.equals(payer)) throw new PreviewError("invalid_input", "callee must differ from payer");
  const meta = SETTLEABLE_MINTS[mint.toBase58()];
  if (!meta) throw new PreviewError("mint_not_settleable", "mint has no Pyth feed accepted by settle_task_v2 (USDC, wSOL)");
  if (!Number.isInteger(input.deadlineSecs) || input.deadlineSecs < 60 || input.deadlineSecs > 30 * 86_400) {
    throw new PreviewError("invalid_input", "deadlineSecs must be an integer in [60, 2592000]");
  }
  const cu = input.computeUnitLimit ?? 300_000;
  const prio = input.priorityFeeMicroLamports ?? 5_000;
  if (!Number.isInteger(cu) || cu < 50_000 || cu > 1_400_000) throw new PreviewError("invalid_input", "computeUnitLimit out of range");
  if (!Number.isInteger(prio) || prio < 0 || prio > 1_000_000) throw new PreviewError("invalid_input", "priorityFeeMicroLamports out of range");

  let vType: VerificationType, vData: Buffer;
  if (input.verification?.type === "payer_approval") { vType = VerificationType.PayerApproval; vData = Buffer.alloc(32); }
  else if (input.verification?.type === "artifact_hash" && /^[0-9a-f]{64}$/.test(input.verification.sha256)) {
    vType = VerificationType.ArtifactHash; vData = Buffer.from(input.verification.sha256, "hex");
  } else throw new PreviewError("invalid_input", "verification must be payer_approval or artifact_hash with a 64-hex sha256");

  const domain = input.domain ?? DEFAULT_DOMAIN;
  if (!/^[a-z0-9_]{1,16}$/.test(domain)) throw new PreviewError("invalid_input", "domain must match [a-z0-9_]{1,16}");
  const cfgAcct = await chain.getAccount(configPda());
  if (!cfgAcct || !cfgAcct.owner.equals(PROGRAM_ID)) throw new PreviewError("config_unavailable", "ProtocolConfig not readable");
  const cfg = decodeProtocolConfig(cfgAcct.data);

  if (input.amountBasis !== "net" && input.amountBasis !== "gross") throw new PreviewError("invalid_input", "amountBasis must be gross or net");
  const requested = parseAmount(input.amount, meta.decimals);
  const gross = input.amountBasis === "net" ? grossUpForNet(requested, cfg.protocolFeeBps) : requested;
  if (gross > U64_MAX) throw new PreviewError("invalid_input", "gross exceeds u64");
  const fee = computeFee(gross, cfg.protocolFeeBps);

  const now = await chain.now();
  const opId = clientOperationId(input.tenant, payer.toBase58(), input.idempotencyKey);
  const task = taskPda(payer, opId);
  const integratorMissing = !(await chain.getAccount(integratorPda(payer)));
  const integratorLamports = integratorMissing ? await chain.minimumBalance(8 + 96) : 0n;

  const warnings: string[] = [];
  const blocking: string[] = [];
  if (cfg.paused) blocking.push("protocol is paused: create_task_v2 would fail");
  if (cfg.executors.length === 0) blocking.push("no executor registered: only payer-direct refund after the deadline would be possible");
  if (await chain.getAccount(task)) blocking.push("a task (or its tombstone) already exists for this idempotencyKey: nothing new will be charged");
  const th = feeThresholds(cfg.protocolFeeBps);
  if (th.firstNonZeroFeeGross !== null && gross < th.firstNonZeroFeeGross) warnings.push(`fee rounds to 0 below ${th.firstNonZeroFeeGross} raw units`);
  if (opts.workerPolicy) {
    const wp = opts.workerPolicy;
    if (!wp.allowedMints.includes(mint.toBase58())) blocking.push("settlement worker policy does not accept this mint: the task would be refunded and the fee kept");
    else if (wp.maxGrossAmountRaw !== null && gross > BigInt(wp.maxGrossAmountRaw)) {
      blocking.push(`gross ${gross} exceeds the settlement worker pilot cap ${wp.maxGrossAmountRaw}: the task would be refunded and the fee kept`);
    }
  } else warnings.push("settlement worker policy not checked (GET /health unavailable)");
  const routing = await chain.getAccount(routingPda(domain));
  if (!routing || !routing.owner.equals(PROGRAM_ID)) blocking.push(`routing domain "${domain}" is not initialized on this cluster: create_task_v2 would fail`);
  const rb = await chain.getAccount(riskBudgetPda(domain));
  if (rb) {
    const u128 = (o: number) => rb.data.readBigUInt64LE(o) + (rb.data.readBigUInt64LE(o + 8) << 64n);
    const start = rb.data.readBigInt64LE(84), dur = rb.data.readBigInt64LE(92);
    const cap = u128(100), used = BigInt(now) >= start + dur ? 0n : u128(132);
    if (used + gross > cap) blocking.push(`shard risk budget: ${used}+${gross} > volume cap ${cap} in the current 24h window (ExceedsVolumeCap)`);
  }

  const lockedRent = RENT_LAMPORTS.task + RENT_LAMPORTS.escrow;
  const binding: TaskPreview["binding"] = {
    cluster: input.cluster, programId: PROGRAM_ID.toBase58(), tenant: input.tenant, payer: payer.toBase58(), callee: callee.toBase58(),
    mint: mint.toBase58(), grossRaw: gross.toString(), deadline: now + input.deadlineSecs, verificationType: vType,
    verificationData: vData.toString("hex"), clientOperationId: opId.toString("hex"), task: task.toBase58(),
    feeBps: cfg.protocolFeeBps.toString(), computeUnitLimit: cu, priorityFeeMicroLamports: prio,
    integratorRegistrationRequired: integratorMissing,
    ...(domain !== DEFAULT_DOMAIN ? { domain } : {}),
  };
  const f = (r: bigint) => formatAmount(r, meta.decimals);
  const expiresAt = now + PREVIEW_TTL_SECS;
  return {
    version: PREVIEW_VERSION,
    binding,
    display: {
      symbol: meta.symbol, decimals: meta.decimals,
      principalRequested: f(requested), payerTransfers: f(gross), fee: f(fee.totalFee), protocolFee: f(fee.protocolFee), affiliateFee: f(fee.affiliateFee),
      calleeReceivesOnRelease: f(fee.net), payerReceivesOnRefund: f(fee.net), feeRetainedOnRefund: f(fee.totalFee),
      feeDestination: `treasury ${ata(TREASURY_AUTHORITY, mint).toBase58()} (no affiliate account is passed, so the 25% affiliate share also goes to the treasury)`,
    },
    rent: {
      taskLamports: RENT_LAMPORTS.task.toString(), escrowLamports: RENT_LAMPORTS.escrow.toString(), tombstoneLamports: RENT_LAMPORTS.tombstone.toString(),
      integratorLamports: integratorLamports.toString(),
      lockedAtCreateLamports: (lockedRent + integratorLamports).toString(),
      returnedToPayerOnCloseLamports: (lockedRent - RENT_LAMPORTS.tombstone).toString(),
      retainedByTombstoneLamports: RENT_LAMPORTS.tombstone.toString(),
      note: "Rent is paid by the payer at creation. close_task_v2 (after a terminal state) returns task+escrow rent minus the 105-byte tombstone to the payer; the tombstone rent stays locked for replay protection. The integrator account rent is a one-time deposit per payer.",
    },
    networkFees: {
      signatures: 1, baseFeeLamports: "5000",
      maxPriorityFeeLamports: ((BigInt(cu) * BigInt(prio) + 999_999n) / 1_000_000n).toString(),
    },
    rules: {
      refund: `Refund returns the net escrow (${f(fee.net)} ${meta.symbol}) to the payer; the ${f(fee.totalFee)} ${meta.symbol} fee taken at creation is not returned. The executor refunds on a payer/callee-signed refund, on a settlement-policy violation, or ${WORKER_REFUND_GRACE_SECS}s after the deadline without valid evidence; the payer can call refund_task_v2 itself once the deadline has passed.`,
      evidence: vType === VerificationType.PayerApproval
        ? "Release requires the payer's ed25519 signature over rufus-v2:release:<program>:<task>, received before the deadline."
        : "Release requires artifact bytes whose SHA-256 equals the committed hash, received before the deadline. The hash proves content identity, not quality.",
      finality: "A receipt is final only after the settle/refund transaction is finalized on-chain.",
    },
    warnings, blocking,
    createdAt: now, expiresAt,
    digest: bindingDigest(binding, now, expiresAt),
  };
}
