/**
 * Funding quickstart: creates ONE escrow task on Solana mainnet after a human approves the exact preview.
 * This moves real USDC. It refuses before signing unless every value is supplied and the operator types the
 * preview digest shown on screen (host authorization outside any LLM).
 *
 *   PAYER_KEYPAIR=<path to a dedicated payer keypair JSON> RPC_URL=<mainnet RPC> \
 *   npx tsx examples/quickstart/fund.ts <worker pubkey> <gross USDC ≤ 10> <idempotency key>
 *
 * Release rule: payer approval. After reviewing the delivery the payer approves with client.releaseTaskEscrow();
 * without delivery, the payer refunds directly after the 48 h deadline (the 2% fee is not refunded).
 * Never use a treasury, multisig or personal main wallet as PAYER_KEYPAIR.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID, RufusEscrowClient, USDC_MINT, connectionReader, connectionSender, keypairSigner, loadPolicy, memoryBudgetTracker,
  memoryNonceStore, signAuthorization, type SpendAuthorizationPayload,
} from "@selecto-infra/agent-adapters/core";

function fail(m: string): never { console.error(m); process.exit(1); }
const [workerArg, grossArg, idKey] = process.argv.slice(2);
if (!workerArg || !grossArg || !idKey) fail("usage: fund.ts <worker pubkey> <gross USDC ≤ 10> <idempotency key>");
if (!process.env.PAYER_KEYPAIR) fail("PAYER_KEYPAIR is not set: nothing signed");
if (!process.env.RPC_URL) fail("RPC_URL is not set: nothing signed");
if (!/^\d+(\.\d{1,6})?$/.test(grossArg) || Number(grossArg) <= 0 || Number(grossArg) > 10) fail("gross must be in (0, 10] USDC (pilot cap)");
if (!/^[A-Za-z0-9._:-]{3,64}$/.test(idKey)) fail("idempotency key must be 3–64 chars [A-Za-z0-9._:-]");
const worker = (() => { try { return new PublicKey(workerArg); } catch { return fail("worker is not a public key"); } })();
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.PAYER_KEYPAIR, "utf-8"))));
if (payer.publicKey.equals(worker)) fail("worker is the payer");

const conn = new Connection(process.env.RPC_URL, "confirmed");
const client = new RufusEscrowClient({
  cluster: "mainnet-beta", chain: connectionReader(conn), sender: connectionSender(conn), signer: keypairSigner(payer), affiliate: null,
  evidenceBaseUrl: "https://api.tryaigility.com", tenant: "quickstart",
  policy: loadPolicy({ version: 1, policyId: "quickstart-fund", cluster: "mainnet-beta", mints: { [USDC_MINT.toBase58()]: { maxGrossPerTaskRaw: "10000000", budgetRaw: "10000000" } },
    allowedCallees: [worker.toBase58()], allowedTools: ["rufus.preview_task", "rufus.create_task", "rufus.get_task", "rufus.request_refund", "rufus.submit_evidence"],
    minDeadlineSecs: 3600, maxDeadlineSecs: 7 * 86_400 }),
  // The human running this script is the approving principal for this payer wallet.
  registry: { principalsFor: () => [{ principal: payer.publicKey.toBase58(), wallets: [payer.publicKey.toBase58()] }] },
  nonces: memoryNonceStore(), budget: memoryBudgetTracker(),
});

const preview = await client.previewTask({
  cluster: "mainnet-beta", tenant: "quickstart", payer: payer.publicKey.toBase58(), callee: worker.toBase58(), mint: USDC_MINT.toBase58(),
  amount: grossArg, amountBasis: "gross", deadlineSecs: 48 * 3600, verification: { type: "payer_approval" }, idempotencyKey: idKey,
});
if (preview.blocking.length) fail(`blocked: ${preview.blocking.join("; ")}`);
console.log(JSON.stringify({ display: preview.display, rent: preview.rent, task: preview.binding.task }, null, 2));
console.log(`\npreview digest: ${preview.digest}  (expires in 5 minutes)`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = (await rl.question("Type the preview digest to fund this task (anything else aborts): ")).trim();
rl.close();
if (typed !== preview.digest) fail("not approved: nothing signed");

const now = Math.floor(Date.now() / 1000);
const authorization = signAuthorization({
  v: 1, domain: "rufus-v2-escrow", programId: PROGRAM_ID.toBase58(), cluster: "mainnet-beta", tenant: "quickstart",
  principal: payer.publicKey.toBase58(), wallet: payer.publicKey.toBase58(), action: "create_task",
  budget: { mint: USDC_MINT.toBase58(), maxGrossRaw: preview.binding.grossRaw }, previewDigest: preview.digest,
  nonce: randomBytes(16).toString("hex"), issuedAt: now, expiresAt: now + 300,
} as SpendAuthorizationPayload, payer.secretKey);
const created = await client.createTask(preview, authorization);
console.log(JSON.stringify(created, null, 2));
if ((created as any).state !== "finalized") fail(`not finalized (${(created as any).state}): check the task before retrying; the same idempotency key can never create a second task`);
console.log(`funded: https://solscan.io/account/${created.task}`);
