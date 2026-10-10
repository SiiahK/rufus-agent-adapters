/**
 * Read-only quickstart: quote an escrow task on Solana mainnet. No private key, nothing is signed or sent.
 *
 *   npx tsx examples/quickstart/preview.ts <payer pubkey> <worker pubkey> [gross USDC, default 5]
 *   env: RPC_URL (default https://api.mainnet-beta.solana.com)
 *
 * Prints every cost (gross, fee, what the worker receives, refund, SOL rent: locked, returned on close, kept by the
 * tombstone), the task address and the preview digest, plus shouldEscrow()'s expected-value check for a given
 * failure probability. The settlement worker's pilot cap (GET https://api.tryaigility.com/health) is 10 USDC gross.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  RufusEscrowClient, USDC_MINT, connectionReader, connectionSender, loadPolicy, memoryBudgetTracker, memoryNonceStore, shouldEscrow,
} from "@selecto-infra/agent-adapters/core";

const [payerArg, workerArg, grossArg = "5"] = process.argv.slice(2);
function fail(m: string): never { console.error(m); process.exit(1); }
if (!payerArg || !workerArg) fail("usage: preview.ts <payer pubkey> <worker pubkey> [gross USDC]");
const payer = (() => { try { return new PublicKey(payerArg); } catch { return fail("payer is not a public key"); } })();
const worker = (() => { try { return new PublicKey(workerArg); } catch { return fail("worker is not a public key"); } })();
if (!/^\d+(\.\d{1,6})?$/.test(grossArg) || Number(grossArg) <= 0 || Number(grossArg) > 10) fail("gross must be a USDC amount in (0, 10]");

const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
// previewTask needs a signer object; this one only exposes the public key and refuses to sign.
const readOnly = { publicKey: payer, signTransaction: async () => fail("read-only example: refusing to sign"), signMessage: async () => fail("read-only example: refusing to sign") };
const client = new RufusEscrowClient({
  cluster: "mainnet-beta", chain: connectionReader(conn), sender: connectionSender(conn), signer: readOnly as any, affiliate: null,
  policy: loadPolicy({ version: 1, policyId: "quickstart-preview", cluster: "mainnet-beta", mints: { [USDC_MINT.toBase58()]: { maxGrossPerTaskRaw: "10000000", budgetRaw: "10000000" } },
    allowedCallees: [worker.toBase58()], allowedTools: ["rufus.preview_task"], minDeadlineSecs: 3600, maxDeadlineSecs: 7 * 86_400 }),
  registry: { principalsFor: () => [] }, nonces: memoryNonceStore(), budget: memoryBudgetTracker(),
});

const preview = await client.previewTask({
  cluster: "mainnet-beta", tenant: "quickstart", payer: payer.toBase58(), callee: worker.toBase58(), mint: USDC_MINT.toBase58(),
  amount: grossArg, amountBasis: "gross", deadlineSecs: 48 * 3600, verification: { type: "payer_approval" }, idempotencyKey: `quickstart-${Date.now()}`,
});
console.log(JSON.stringify({ display: preview.display, rent: preview.rent, networkFees: (preview as any).networkFees, task: preview.binding.task, digest: preview.digest, blocking: preview.blocking }, null, 2));

// Is escrow worth its fee here? Expected value: p · r · P > F + O (fee inside the gross, not refunded).
const priceRaw = BigInt(Math.round(Number(grossArg) * 1e6));
for (const p of [0.005, 0.05]) {
  const e = shouldEscrow({ priceRaw, failureProbability: p });
  console.log(`failure probability ${p * 100}%: ${e.useEscrow ? "escrow pays off" : "escrow costs more than it saves"} (expected recovery ${e.expectedRecoveryRaw} vs fee ${e.feeRaw} raw; break-even ${(e.breakEvenFailureProbability * 100).toFixed(2)}%)`);
}
