/**
 * Select v2 Escrow protocol constants, PDAs, decoders and instruction builders.
 *
 * Mirrors src/solana/v2-settlement.ts and scripts/v2-pilot.ts (the code paths used on mainnet);
 * tests/gtm/protocol-parity.test.ts fails if the two drift. Nothing here changes on-chain rules.
 */

import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("E3XAx7qEKHte9kmWKhuyAVxb8CgE2g4k5FqkrRx2kdsF");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
/** Squads vault #0: program upgrade authority, protocol admin and treasury authority on mainnet. */
export const TREASURY_AUTHORITY = new PublicKey("HBZPPQpwzmMNrvbT3SywLWQofpCzwdJFeGeG2CcZcT6j");

/** Mints with a Pyth PriceUpdateV2 feed accepted by settle_task_v2 (expected_feed_for_mint). */
export const SETTLEABLE_MINTS: Record<string, { symbol: string; decimals: number; priceFeed: PublicKey }> = {
  [USDC_MINT.toBase58()]: { symbol: "USDC", decimals: 6, priceFeed: new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX") },
  [NATIVE_MINT.toBase58()]: { symbol: "wSOL", decimals: 9, priceFeed: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE") },
};

/** On-chain constants (programs/agent-registry/src/m2m_v2/state.rs, lib.rs). */
export const BPS_DENOMINATOR = 10_000n;
export const AFFILIATE_SHARE_OF_FEE_BPS = 2_500n;
export const DEFAULT_DOMAIN = "m2m";
/**
 * Routing domain with the higher 24h volume cap (35 000 USDC per shard window), created on mainnet by the Squads
 * multisig on 2026-10-01. New tasks use it by default; tasks on "m2m" keep working (settlement reads the domain
 * stored in each task).
 */
export const PAYMENTS_V2_DOMAIN = "payments_v2";
const DOMAIN_RE = /^[a-z0-9_]{1,16}$/;

/** Host choice: explicit option, else RUFUS_ROUTING_DOMAIN, else payments_v2. */
export function resolveRoutingDomain(explicit?: string | null, env: Record<string, string | undefined> = process.env): string {
  const d = explicit ?? env.RUFUS_ROUTING_DOMAIN?.trim() ?? PAYMENTS_V2_DOMAIN;
  if (!DOMAIN_RE.test(d)) throw new Error("routing domain must match [a-z0-9_]{1,16}");
  return d;
}

/** Rent-exempt minimums observed on mainnet (finalized read, slot 451162698). */
export const RENT_LAMPORTS = { task: 2_560_320n, escrow: 1_488_440n, tombstone: 1_183_640n } as const;

export enum TaskStatus { Created = 0, Funded = 1, Active = 2, Completed = 3, Disputed = 4, Refunded = 5, Cancelled = 6 }
export enum VerificationType { PayerApproval = 0, ArtifactHash = 1 }

const sha = (s: string) => createHash("sha256").update(s).digest();
export const accountDiscriminator = (name: string) => sha(`account:${name}`).subarray(0, 8);
export const ixDiscriminator = (name: string) => sha(`global:${name}`).subarray(0, 8);
export const eventDiscriminator = (name: string) => sha(`event:${name}`).subarray(0, 8);

export const TASK_DISCRIMINATOR = accountDiscriminator("TaskAccountV2");
export const TOMBSTONE_DISCRIMINATOR = accountDiscriminator("TaskV2Tombstone");
export const CONFIG_DISCRIMINATOR = accountDiscriminator("ProtocolConfig");

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };

export const configPda = () => pda([Buffer.from("proto_cfg_v2")]);
export const routingPda = (domain = DEFAULT_DOMAIN) => pda([Buffer.from("routing_v2"), Buffer.from(domain)]);
export const riskBudgetPda = (domain = DEFAULT_DOMAIN, shardId = 0, windowId = 0n) =>
  pda([Buffer.from("risk_v2"), routingPda(domain).toBuffer(), u32(shardId), u64(windowId)]);
export const integratorPda = (authority: PublicKey) => pda([Buffer.from("integrator_v1"), authority.toBuffer()]);
export const taskPda = (payer: PublicKey, clientOperationId: Buffer) => pda([Buffer.from("task_v2"), payer.toBuffer(), clientOperationId]);
export const escrowPda = (task: PublicKey) => pda([Buffer.from("escrow_v2"), task.toBuffer()]);
export const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

// ── Decoders ────────────────────────────────────────────────

export interface ProtocolConfigView {
  admin: PublicKey; treasuryAuthority: PublicKey; paused: boolean;
  protocolFeeBps: bigint; referralFeeBps: bigint; version: number; executors: PublicKey[];
}

export function decodeProtocolConfig(data: Buffer): ProtocolConfigView {
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) throw new Error("not a ProtocolConfig");
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  const execOffset = 8 + 32 * 4 + 1 + 2 + 2 + 2;
  const count = data[execOffset + 96];
  return {
    admin: pk(8), treasuryAuthority: pk(72), paused: data[136] === 1,
    protocolFeeBps: BigInt(data.readUInt16LE(137)), referralFeeBps: BigInt(data.readUInt16LE(139)), version: data.readUInt16LE(141),
    executors: Array.from({ length: count }, (_, i) => pk(execOffset + i * 32)),
  };
}

export interface TaskView {
  payer: PublicKey; clientOperationId: Buffer; callerAgent: PublicKey; calleeAgent: PublicKey;
  escrowAmount: bigint; protocolFee: bigint; affiliateFee: bigint; integrator: PublicKey;
  status: TaskStatus; deadline: bigint; resultHash: Buffer; verificationType: number; verificationData: Buffer;
  escrowMint: PublicKey; createdAt: bigint;
}

/** TaskAccountV2 (Borsh 372 bytes, allocated 376 on-chain). */
export function decodeTask(data: Buffer): TaskView {
  if (data.length < 372 || !data.subarray(0, 8).equals(TASK_DISCRIMINATOR)) throw new Error("not a TaskAccountV2");
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  return {
    payer: pk(8), clientOperationId: Buffer.from(data.subarray(40, 72)), callerAgent: pk(72), calleeAgent: pk(104),
    escrowAmount: data.readBigUInt64LE(136), protocolFee: data.readBigUInt64LE(144), affiliateFee: data.readBigUInt64LE(152),
    integrator: pk(160), status: data[193], deadline: data.readBigInt64LE(194), resultHash: Buffer.from(data.subarray(202, 234)),
    verificationType: data[234], verificationData: Buffer.from(data.subarray(235, 267)),
    escrowMint: pk(296), createdAt: data.readBigInt64LE(362),
  };
}

export interface TombstoneView { payer: PublicKey; clientOperationId: Buffer; resultHash: Buffer; terminalStatus: "completed" | "refunded" | "cancelled"; }

export function decodeTombstone(data: Buffer): TombstoneView {
  if (data.length < 105 || !data.subarray(0, 8).equals(TOMBSTONE_DISCRIMINATOR)) throw new Error("not a TaskV2Tombstone");
  const status = (["completed", "refunded", "cancelled"] as const)[data[104]];
  if (!status) throw new Error(`unknown terminal status ${data[104]}`);
  return { payer: new PublicKey(data.subarray(8, 40)), clientOperationId: Buffer.from(data.subarray(40, 72)), resultHash: Buffer.from(data.subarray(72, 104)), terminalStatus: status };
}

// ── Evidence messages ───────────────────────────────────────

export type ApprovalAction = "release" | "refund";

/** Message the payer (release) or payer/callee (refund) signs; verified by the settlement worker. */
export function approvalMessage(action: ApprovalAction, task: PublicKey): Buffer {
  return Buffer.from(`rufus-v2:${action}:${PROGRAM_ID.toBase58()}:${task.toBase58()}`, "utf-8");
}

// ── Instructions ────────────────────────────────────────────

/** register_integrator(referral_mode=0, commission_wallet). Without an affiliate ATA at create, the whole fee goes to the treasury. */
export function buildRegisterIntegratorIx(authority: PublicKey, commissionWallet: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: integratorPda(authority), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ixDiscriminator("register_integrator"), Buffer.from([0]), commissionWallet.toBuffer()]),
  });
}

export interface CreateTaskIxParams {
  payer: PublicKey; callee: PublicKey; caller?: PublicKey; mint: PublicKey; grossAmount: bigint; deadline: bigint;
  clientOperationId: Buffer; verificationType: VerificationType; verificationData: Buffer;
  integratorConfig: PublicKey; treasuryTokenAccount: PublicKey; domain?: string;
  /** Third-party affiliate token account (DirectWallet integrators only). Never the payer's own account. */
  affiliateTokenAccount?: PublicKey;
}

export function buildCreateTaskIx(p: CreateTaskIxParams): TransactionInstruction {
  if (p.clientOperationId.length !== 32) throw new Error("clientOperationId must be 32 bytes");
  if (p.verificationData.length !== 32) throw new Error("verificationData must be 32 bytes");
  const task = taskPda(p.payer, p.clientOperationId);
  const keys = [
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: task, isSigner: false, isWritable: true },
    { pubkey: escrowPda(task), isSigner: false, isWritable: true },
    { pubkey: p.mint, isSigner: false, isWritable: false },
    { pubkey: ata(p.payer, p.mint), isSigner: false, isWritable: true },
    { pubkey: p.treasuryTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: routingPda(p.domain), isSigner: false, isWritable: false },
    { pubkey: riskBudgetPda(p.domain), isSigner: false, isWritable: true },
    { pubkey: p.integratorConfig, isSigner: false, isWritable: false },
  ];
  if (p.affiliateTokenAccount) keys.push({ pubkey: p.affiliateTokenAccount, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.concat([
      ixDiscriminator("create_task_v2"), p.clientOperationId, (p.caller ?? p.payer).toBuffer(), p.callee.toBuffer(),
      u64(p.grossAmount), i64(p.deadline), Buffer.from([p.verificationType]), p.verificationData,
    ]),
  });
}

/** refund_task_v2 signed by the payer itself: the program accepts it only after the deadline. */
export function buildPayerRefundIx(task: PublicKey, payer: PublicKey, payerTokenAccount: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: task, isSigner: false, isWritable: true },
      { pubkey: escrowPda(task), isSigner: false, isWritable: true },
      { pubkey: payerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: ixDiscriminator("refund_task_v2"),
  });
}

/** close_task_v2 is permissionless; the program pays the released rent only to the task payer. */
export function buildCloseIx(task: PublicKey, payer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: task, isSigner: false, isWritable: true },
      { pubkey: escrowPda(task), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: ixDiscriminator("close_task_v2"),
  });
}
