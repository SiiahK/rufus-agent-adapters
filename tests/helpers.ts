/** In-memory ChainReader with a ProtocolConfig laid out exactly like the deployed account (no network). */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CONFIG_DISCRIMINATOR, PROGRAM_ID, TREASURY_AUTHORITY, USDC_MINT, configPda, loadPolicy, memoryBudgetTracker, memoryNonceStore,
  RufusEscrowClient, type ChainReader, type AgentSpendPolicy,
} from "../src/index.js";

export const NOW = 1_790_600_000;

export function protocolConfig(feeBps = 200, paused = false, executors: PublicKey[] = [Keypair.generate().publicKey]): Buffer {
  const b = Buffer.alloc(8 + 32 * 4 + 1 + 2 + 2 + 2 + 96 + 1 + 1);
  CONFIG_DISCRIMINATOR.copy(b, 0);
  TREASURY_AUTHORITY.toBuffer().copy(b, 8);
  TREASURY_AUTHORITY.toBuffer().copy(b, 72);
  b[136] = paused ? 1 : 0;
  b.writeUInt16LE(feeBps, 137);
  b.writeUInt16LE(50, 139);
  b.writeUInt16LE(2, 141);
  executors.forEach((e, i) => e.toBuffer().copy(b, 143 + i * 32));
  b[143 + 96] = executors.length;
  return b;
}

export function mockChain(feeBps = 200, opts: { paused?: boolean } = {}): ChainReader & { now_: number } {
  const accounts = new Map<string, Buffer>([[configPda().toBase58(), protocolConfig(feeBps, opts.paused)]]);
  const chain = {
    now_: NOW,
    getAccount: async (a: PublicKey) => {
      const d = accounts.get(a.toBase58());
      return d ? { data: d, owner: PROGRAM_ID, lamports: 1_000_000n } : null;
    },
    minimumBalance: async (size: number) => BigInt((size + 128) * 5080),
    now: async () => chain.now_,
  };
  return chain;
}

export function makeClient(chain: ChainReader, payer: Keypair, callee: PublicKey, principal: Keypair, over: Partial<AgentSpendPolicy> = {}) {
  return new RufusEscrowClient({
    cluster: "localnet", chain,
    policy: loadPolicy({
      version: 1, policyId: "test", cluster: "localnet", mints: { [USDC_MINT.toBase58()]: { maxGrossPerTaskRaw: "1000000", budgetRaw: "3000000" } },
      allowedCallees: [callee.toBase58()], allowedTools: ["rufus.preview_task", "rufus.create_task", "rufus.get_task", "rufus.get_receipt"],
      minDeadlineSecs: 60, maxDeadlineSecs: 86_400, ...over,
    }),
    registry: { principalsFor: (t) => (t === "acme" ? [{ principal: principal.publicKey.toBase58(), wallets: [payer.publicKey.toBase58()] }] : []) },
    nonces: memoryNonceStore(), budget: memoryBudgetTracker(),
  });
}
