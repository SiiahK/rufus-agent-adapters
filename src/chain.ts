/**
 * Chain access and signing seams. Signing keys live only behind `TaskSigner` (wallet adapter, HSM,
 * Turnkey, local keypair for tests); nothing in the adapter serializes or logs key material.
 */

import nacl from "tweetnacl";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

export interface AccountSnapshot { data: Buffer; owner: PublicKey; lamports: bigint; }

export interface ChainReader {
  getAccount(address: PublicKey): Promise<AccountSnapshot | null>;
  minimumBalance(size: number): Promise<bigint>;
  now(): Promise<number>;
}

export type Commitment = "processed" | "confirmed" | "finalized";

export interface SignatureStatus { confirmationStatus: Commitment | null; err: unknown | null; slot?: number; }

export interface TxSender {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  simulate(tx: Transaction): Promise<{ ok: boolean; logs: string[]; err?: unknown; unitsConsumed?: number }>;
  send(raw: Buffer): Promise<string>;
  signatureStatus(signature: string): Promise<SignatureStatus | null>;
  blockHeight(): Promise<number>;
}

export interface TaskSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export function keypairSigner(kp: Keypair): TaskSigner {
  return {
    publicKey: kp.publicKey,
    async signTransaction(tx) { tx.partialSign(kp); return tx; },
    async signMessage(m) { return nacl.sign.detached(m, kp.secretKey); },
  };
}

const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

export function connectionReader(conn: Connection): ChainReader {
  return {
    async getAccount(address) {
      const a = await conn.getAccountInfo(address, "confirmed");
      return a ? { data: a.data, owner: a.owner, lamports: BigInt(a.lamports) } : null;
    },
    minimumBalance: async (size) => BigInt(await conn.getMinimumBalanceForRentExemption(size)),
    /** Cluster time from the Clock sysvar (unix_timestamp at offset 32), the clock the program uses for deadlines.
     *  getBlockTime(latest slot) is only a fallback: some RPCs have not stored the newest block yet. */
    now: async () => {
      const clock = await conn.getAccountInfo(CLOCK_SYSVAR, "confirmed");
      if (clock && clock.data.length >= 40) return Number(clock.data.readBigInt64LE(32));
      const slot = await conn.getSlot("confirmed");
      return (await conn.getBlockTime(slot).catch(() => null)) ?? Math.floor(Date.now() / 1000);
    },
  };
}

export function connectionSender(conn: Connection): TxSender {
  return {
    latestBlockhash: () => conn.getLatestBlockhash("confirmed"),
    async simulate(tx) {
      const r = await conn.simulateTransaction(tx);
      return { ok: !r.value.err, logs: r.value.logs ?? [], err: r.value.err ?? undefined, unitsConsumed: r.value.unitsConsumed };
    },
    send: (raw) => conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 }),
    async signatureStatus(sig) {
      const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = r.value[0];
      return s ? { confirmationStatus: (s.confirmationStatus ?? null) as Commitment | null, err: s.err, slot: s.slot } : null;
    },
    blockHeight: () => conn.getBlockHeight("confirmed"),
  };
}
