/**
 * After delivery: the payer releases the task to the worker, or asks for a refund. Moves real USDC.
 * Pairs with fund.ts (same PAYER_KEYPAIR, worker and idempotency key → same task address).
 *
 *   PAYER_KEYPAIR=<payer keypair file> RPC_URL=<mainnet RPC> npx tsx examples/quickstart/decide.ts release <worker pubkey> <idempotency key>
 *   PAYER_KEYPAIR=…                     RPC_URL=…            npx tsx examples/quickstart/decide.ts refund  <worker pubkey> <idempotency key>
 *
 * release: signs the payer approval; Select's settlement worker pays the worker (net of the 2% fee) on its next poll.
 * refund:  before the deadline, a signed refund request (the executor refunds; within the optimistic window it is a
 *          dispute); after the deadline, the payer refunds directly on-chain. The 2% fee is not refunded.
 * The operator must type the task address shown on screen; anything else aborts before signing.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID, RufusEscrowClient, USDC_MINT, connectionReader, connectionSender, keypairSigner, loadPolicy, memoryBudgetTracker,
  memoryNonceStore, signAuthorization, type HostAuthorize, type SpendAuthorizationPayload,
} from "@selecto-infra/agent-adapters/core";

function fail(m: string): never { console.error(m); process.exit(1); }
const [action, workerArg, idKey] = process.argv.slice(2);
if (action !== "release" && action !== "refund") fail("usage: decide.ts <release|refund> <worker pubkey> <idempotency key>");
if (!workerArg || !idKey) fail("usage: decide.ts <release|refund> <worker pubkey> <idempotency key>");
if (!process.env.PAYER_KEYPAIR || !process.env.RPC_URL) fail("PAYER_KEYPAIR and RPC_URL are required: nothing signed");
const worker = (() => { try { return new PublicKey(workerArg); } catch { return fail("worker is not a public key"); } })();
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.PAYER_KEYPAIR, "utf-8"))));

const conn = new Connection(process.env.RPC_URL, "confirmed");
const client = new RufusEscrowClient({
  cluster: "mainnet-beta", chain: connectionReader(conn), sender: connectionSender(conn), signer: keypairSigner(payer), affiliate: null,
  evidenceBaseUrl: "https://api.tryaigility.com", tenant: "quickstart",
  policy: loadPolicy({ version: 1, policyId: "quickstart-decide", cluster: "mainnet-beta", mints: { [USDC_MINT.toBase58()]: { maxGrossPerTaskRaw: "10000000", budgetRaw: "10000000" } },
    allowedCallees: [worker.toBase58()], allowedTools: ["rufus.get_task", "rufus.request_refund", "rufus.submit_evidence"], minDeadlineSecs: 3600, maxDeadlineSecs: 7 * 86_400 }),
  registry: { principalsFor: () => [{ principal: payer.publicKey.toBase58(), wallets: [payer.publicKey.toBase58()] }] },
  nonces: memoryNonceStore(), budget: memoryBudgetTracker(),
});

const task = client.taskAddress(idKey, "quickstart");
const view = await client.getTask(task);
if (view.onChain.kind !== "task") fail(`no live task at ${task} (${view.onChain.kind})`);
console.log(JSON.stringify({ task, status: view.onChain.task.status, callee: view.onChain.task.calleeAgent.toBase58(), deadline: new Date(Number(view.onChain.task.deadline) * 1000).toISOString() }, null, 2));
if (view.onChain.task.calleeAgent.toBase58() !== worker.toBase58()) fail("this task pays another worker: nothing signed");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = (await rl.question(`Type the task address to ${action} it (anything else aborts): `)).trim();
rl.close();
if (typed !== task) fail("not confirmed: nothing signed");

const authorize: HostAuthorize = async (r) => {
  const now = Math.floor(Date.now() / 1000);
  return signAuthorization({ v: 1, domain: "rufus-v2-escrow", programId: PROGRAM_ID.toBase58(), cluster: "mainnet-beta", tenant: r.tenant,
    principal: payer.publicKey.toBase58(), wallet: r.wallet, action: r.action, budget: { mint: USDC_MINT.toBase58(), maxGrossRaw: "0" },
    nonce: randomBytes(16).toString("hex"), issuedAt: now, expiresAt: now + 300, task: r.task } as SpendAuthorizationPayload, payer.secretKey);
};
const r = action === "release"
  ? await client.releaseTaskEscrow({ taskId: idKey, providerPubkey: worker.toBase58(), authorize })
  : await client.refundTaskEscrow({ taskId: idKey, authorize });
console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(`state: https://api.tryaigility.com/v2/tasks/${task}/settlement`);
