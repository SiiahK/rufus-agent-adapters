/**
 * Select service agent: a 5 USDC technical dossier of a Solana repository, paid through Select Escrow.
 *
 *   WORKER_KEYPAIR=<worker keypair> RPC_URL=<mainnet RPC> npm run start:service-worker -- --task <task> --repo <owner/name> [--ref <branch|commit>]
 *   npm run start:service-worker -- --repo <owner/name>            # preview: build the dossier and its hash, no task, nothing sent
 *   add --dry-run to check the task and build the dossier without posting the delivery report
 *
 * 1. The buyer funds a payer-approval task naming this worker (examples/quickstart/fund.ts, 5 USDC).
 * 2. This script checks the task on-chain (callee = this worker, funded, payer approval, price, deadline), clones the
 *    repository, writes the dossier and its SHA-256, and posts the worker's signed delivery report.
 * 3. The buyer receives the file (out/<task>.md, sent by the operator), checks the SHA-256 against
 *    GET /v2/tasks/<task>/settlement, and releases (decide.ts) or disputes. With no dispute, Select's executor
 *    releases after the 30-minute optimistic window. The worker never signs a payment and never holds the buyer's USDC.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { PROGRAM_ID, TaskStatus, USDC_MINT, VerificationType, decodeTask, deliveryMessage } from "@selecto-infra/agent-adapters/core";
import { renderMarkdown, scanRepo, type OnChainProgram } from "./dossier.js";

const API = process.env.SELECT_API ?? "https://api.tryaigility.com";
const PRICE_RAW = BigInt(Math.round(Number(process.env.PRICE_USDC ?? "5") * 1e6)); // gross the buyer must lock
const MIN_TIME_LEFT_SECS = 15 * 60;
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function fail(m: string): never { console.error(`refused: ${m}`); process.exit(1); }
const { values: a } = parseArgs({ options: { task: { type: "string" }, repo: { type: "string" }, ref: { type: "string" }, out: { type: "string", default: "out" }, "dry-run": { type: "boolean", default: false } } });
if (!a.repo) fail("--repo <owner/name or https://github.com/owner/name> is required");
const repoUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/.test(a.repo) ? a.repo.replace(/\.git$/, "")
  : /^[\w.-]+\/[\w.-]+$/.test(a.repo) ? `https://github.com/${a.repo}` : fail("only public GitHub repositories are supported");
if (a.ref && !/^[\w./-]{1,100}$/.test(a.ref)) fail("invalid --ref");
const conn = process.env.RPC_URL ? new Connection(process.env.RPC_URL, "confirmed") : null;

// ── 1. The job must be a funded task that pays this worker ──────────────────────
let worker: Keypair | null = null;
if (a.task) {
  if (!process.env.WORKER_KEYPAIR || !conn) fail("WORKER_KEYPAIR and RPC_URL are required with --task");
  worker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WORKER_KEYPAIR, "utf-8"))));
  const task = (() => { try { return new PublicKey(a.task!); } catch { return fail("--task is not an address"); } })();
  const acc = await conn.getAccountInfo(task, "confirmed");
  if (!acc || !acc.owner.equals(PROGRAM_ID)) fail("no Select Escrow task at this address");
  const t = (() => { try { return decodeTask(acc.data); } catch { return fail("the account is closed or not a live task"); } })();
  const gross = t.escrowAmount + t.protocolFee + t.affiliateFee, now = Math.floor(Date.now() / 1000);
  const checks: [boolean, string][] = [
    [t.calleeAgent.equals(worker.publicKey), `task pays ${t.calleeAgent.toBase58()}, not this worker`],
    [t.status === TaskStatus.Funded || t.status === TaskStatus.Active, `task status is ${TaskStatus[t.status]}`],
    [t.verificationType === VerificationType.PayerApproval, "task must use payer approval (a report's hash is not known in advance)"],
    [t.escrowMint.equals(USDC_MINT), "task is not in USDC"],
    [gross >= PRICE_RAW, `task gross ${gross} is below the price ${PRICE_RAW}`],
    [Number(t.deadline) - now >= MIN_TIME_LEFT_SECS, "less than 15 minutes left before the deadline"],
  ];
  for (const [ok, why] of checks) if (!ok) fail(why);
  console.log(JSON.stringify({ task: task.toBase58(), payer: t.payer.toBase58(), grossRaw: gross.toString(), netToWorkerRaw: t.escrowAmount.toString(), deadline: new Date(Number(t.deadline) * 1000).toISOString() }, null, 2));
}

// ── 2. Build the dossier (re-used if this task already has one, so the hash never changes) ──
mkdirSync(a.out!, { recursive: true });
const outFile = join(a.out!, `${a.task ?? "preview"}.md`);
let commit: string;
if (a.task && existsSync(outFile)) {
  commit = /Commit `([0-9a-f]{40})`/.exec(readFileSync(outFile, "utf-8"))?.[1] ?? fail(`${outFile} exists but has no commit; move it away`);
  console.log(`re-using ${outFile}`);
} else {
  const dir = mkdtempSync(join(tmpdir(), "select-dossier-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", ...(a.ref ? ["--branch", a.ref] : []), repoUrl, dir], { stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 });
    commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const base = scanRepo(dir, repoUrl, commit);
    const onChain: OnChainProgram[] = [];
    for (const { id } of base.programIds) onChain.push(conn ? await programState(conn, new PublicKey(id)) : { programId: id, state: "unchecked" });
    writeFileSync(outFile, renderMarkdown({ ...base, onChain }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const bytes = readFileSync(outFile);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const requestDigest = createHash("sha256").update(`select-dossier:v1:${a.task ?? "preview"}:${repoUrl}:${commit}`).digest("hex");
console.log(JSON.stringify({ dossier: outFile, bytes: bytes.length, sha256, commit }, null, 2));
if (!a.task || !worker) { console.log("preview only: no task, nothing sent"); process.exit(0); }

// ── 3. Signed delivery report → optimistic release unless the buyer disputes ───────
const signature = Buffer.from(nacl.sign.detached(deliveryMessage(new PublicKey(a.task), sha256, requestDigest), worker.secretKey)).toString("hex");
const report = { sha256, requestDigest, bytes: bytes.length, signer: worker.publicKey.toBase58(), signature };
if (a["dry-run"]) { console.log("dry run: delivery report built, not posted"); process.exit(0); }
const r = await fetch(`${API}/v2/tasks/${a.task}/delivery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report), signal: AbortSignal.timeout(20_000) });
const body = await r.json().catch(() => null);
if (r.status !== 202) fail(`delivery report not accepted: HTTP ${r.status} ${JSON.stringify(body)}`);
const s = await (await fetch(`${API}/v2/tasks/${a.task}/settlement`, { signal: AbortSignal.timeout(20_000) })).json().catch(() => null) as { optimisticReleaseAt?: number | null } | null;
console.log(JSON.stringify({ delivery: body, optimisticReleaseAt: s?.optimisticReleaseAt ? new Date(s.optimisticReleaseAt * 1000).toISOString() : null }, null, 2));
console.log(`Send ${outFile} to the buyer now. State: ${API}/v2/tasks/${a.task}/settlement · receipt after settlement: ${API}/v2/receipts/${a.task}`);

async function programState(c: Connection, id: PublicKey): Promise<OnChainProgram> {
  const acc = await c.getAccountInfo(id, "confirmed");
  if (!acc) return { programId: id.toBase58(), state: "not_found" };
  if (!acc.executable) return { programId: id.toBase58(), state: "not_a_program" };
  if (!acc.owner.equals(UPGRADEABLE_LOADER)) return { programId: id.toBase58(), state: "immutable", authority: null };
  const pd = await c.getAccountInfo(new PublicKey(acc.data.subarray(4, 36)), "confirmed");
  if (!pd || pd.data[12] !== 1) return { programId: id.toBase58(), state: "immutable", authority: null };
  return { programId: id.toBase58(), state: "upgradeable", authority: new PublicKey(pd.data.subarray(13, 45)).toBase58() };
}
