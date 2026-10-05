/**
 * Tool logic of @rufus/mcp-server-escrow (transport-free, so it is testable without an MCP client).
 *
 * The server holds NO private key. Financial tools return an UNSIGNED transaction (or the exact message to
 * sign) for the host wallet; the agent never gets a generic signing capability. Spending is bounded by
 * MCP_ESCROW_MAX_GROSS_RAW and the program's own checks. The integrator (affiliate) comes only from the
 * server's environment (SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY / RUFUS_AFFILIATE_PUBKEY), is validated on-chain
 * as a DirectWallet integrator and is never the payer; tool input cannot set it.
 */

import {
  web3, PROGRAM_ID, TaskStatus, VerificationType, approvalMessage, ata, buildCreateInstructions, buildPayerRefundIx, configPda,
  decodeProtocolConfig, decodeTask, decodeTombstone, formatAmount, integratorOnboarding, previewTask, resolveRoutingDomain, SETTLEABLE_MINTS, USDC_MINT, type ChainReader,
} from "../../src/core.js";

const { PublicKey, Transaction, ComputeBudgetProgram } = web3;

export interface EscrowToolDeps {
  chain: ChainReader;
  cluster: "mainnet-beta" | "devnet" | "localnet";
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Integrator authority from the server environment (already parsed); null = treasury keeps the share. */
  affiliate: string | null;
  /** Per-task ceiling for create_escrow_task (atomic units). */
  maxGrossRaw: bigint;
  /** Evidence intake of the settlement worker, e.g. https://api.tryaigility.com */
  evidenceBaseUrl: string;
  /** Account-change subscription (websocket); falls back to polling when absent. */
  /** Routing domain for new tasks (RUFUS_ROUTING_DOMAIN, else payments_v2). */
  domain?: string;
  subscribe?(account: InstanceType<typeof PublicKey>, onChange: () => void): Promise<() => Promise<void> | void>;
  pollMs?: number;
}

export class ToolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ToolError"; }
}

const key = (v: string, f: string) => { try { return new PublicKey(v); } catch { throw new ToolError("invalid_input", `${f} is not a public key`); } };
const unsigned = (tx: InstanceType<typeof Transaction>) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

export async function createEscrowTask(d: EscrowToolDeps, i: { payer: string; providerPubkey: string; amountRaw: string; taskId: string; timeoutSeconds: number; mint?: string; tenant?: string }) {
  const payer = key(i.payer, "payer"), mint = i.mint ?? USDC_MINT.toBase58();
  if (!/^[1-9][0-9]{0,19}$/.test(i.amountRaw)) throw new ToolError("invalid_input", "amountRaw must be a positive integer string");
  const gross = BigInt(i.amountRaw);
  if (gross > d.maxGrossRaw) throw new ToolError("over_limit", `amountRaw exceeds MCP_ESCROW_MAX_GROSS_RAW (${d.maxGrossRaw})`);
  const meta = SETTLEABLE_MINTS[mint];
  if (!meta) throw new ToolError("invalid_input", "mint is not settleable");
  const preview = await previewTask({
    cluster: d.cluster, tenant: i.tenant ?? "mcp", payer: payer.toBase58(), callee: i.providerPubkey, mint, amount: formatAmount(gross, meta.decimals), amountBasis: "gross",
    deadlineSecs: i.timeoutSeconds, verification: { type: "payer_approval" }, idempotencyKey: i.taskId, domain: resolveRoutingDomain(d.domain),
  }, d.chain);
  if (preview.blocking.length) throw new ToolError("preview_blocked", preview.blocking.join("; "));
  const cfg = decodeProtocolConfig((await d.chain.getAccount(configPda()))!.data);
  const { ixs, route } = await buildCreateInstructions(d.chain, preview, payer, d.affiliate, cfg.treasuryAuthority);
  const bh = await d.latestBlockhash();
  const tx = new Transaction({ feePayer: payer, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }).add(...ixs);
  const fee = BigInt(preview.binding.feeBps), total = (gross * fee) / 10_000n, share = (total * 2_500n) / 10_000n;
  return {
    task: preview.binding.task, unsignedTransactionBase64: unsigned(tx), lastValidBlockHeight: bh.lastValidBlockHeight,
    amountsRaw: { gross: gross.toString(), fee: total.toString(), commission: route.kind === "affiliate" ? share.toString() : "0", treasury: (route.kind === "affiliate" ? total - share : total).toString(), releasableToProvider: (gross - total).toString() },
    commission: route.kind === "affiliate" ? { to: route.commissionWallet, tokenAccount: route.affiliateTokenAccount.toBase58() } : { to: "treasury", reason: route.reason },
    rules: preview.rules, previewDigest: preview.digest,
    next: "Sign with the payer wallet and send. This server holds no key and sends nothing. The same taskId always maps to the same task (no second fee).",
  };
}

const STATE = (s: TaskStatus) => (s === TaskStatus.Funded || s === TaskStatus.Active ? "funded" : [TaskStatus.Completed, TaskStatus.Refunded, TaskStatus.Cancelled].includes(s) ? "terminal" : "pending");

async function readTask(d: EscrowToolDeps, task: InstanceType<typeof PublicKey>) {
  const a = await d.chain.getAccount(task);
  if (!a || !a.owner.equals(PROGRAM_ID)) return null;
  try { return decodeTask(a.data); } catch { return null; }
}

/** Waits (websocket subscription when available, else polling) until the task is funded/terminal or the timeout ends. Read-only. */
export async function verifyCollateral(d: EscrowToolDeps, i: { task: string; until?: "funded" | "terminal"; timeoutSeconds?: number; payee?: string; minGrossRaw?: string }) {
  const task = key(i.task, "task"), until = i.until ?? "funded", limitMs = Math.min(Math.max(i.timeoutSeconds ?? 30, 1), 120) * 1000;
  const check = async () => {
    const t = await readTask(d, task);
    if (!t) return null;
    const st = STATE(t.status);
    const gross = t.escrowAmount + t.protocolFee + t.affiliateFee;
    const ok = until === "funded" ? st === "funded" || st === "terminal" : st === "terminal";
    return ok ? { status: TaskStatus[t.status], grossRaw: gross.toString(), callee: t.calleeAgent.toBase58(), mint: t.escrowMint.toBase58(), deadline: Number(t.deadline),
      payeeMatches: i.payee ? t.calleeAgent.toBase58() === i.payee : null, amountCovers: i.minGrossRaw ? gross >= BigInt(i.minGrossRaw) : null } : null;
  };
  const first = await check();
  if (first) return { satisfied: true, ...first, via: "initial read" };
  return await new Promise<Record<string, unknown>>((resolve) => {
    let done = false, unsub: (() => Promise<void> | void) | undefined, timer: ReturnType<typeof setInterval> | undefined;
    const finish = async (v: Record<string, unknown>) => { if (done) return; done = true; clearTimeout(deadline); if (timer) clearInterval(timer); await unsub?.(); resolve(v); };
    const deadline = setTimeout(() => void finish({ satisfied: false, reason: `not ${until} within ${limitMs / 1000}s`, via: d.subscribe ? "websocket" : "polling" }), limitMs);
    const onChange = () => { void check().then((r) => r && finish({ satisfied: true, ...r, via: d.subscribe ? "websocket" : "polling" })); };
    if (d.subscribe) void d.subscribe(task, onChange).then((u) => { unsub = u; if (done) void u(); });
    else timer = setInterval(onChange, d.pollMs ?? 1000);
  });
}

/** Returns the exact release message the PAYER must sign and where to send it; the executor settles after verifying it. */
export async function releaseEscrowTask(d: EscrowToolDeps, i: { task: string }) {
  const task = key(i.task, "task"), t = await readTask(d, task);
  if (!t) throw new ToolError("task_not_live", "task is closed or absent");
  if (STATE(t.status) !== "funded") throw new ToolError("task_not_pending", `task is ${TaskStatus[t.status]}`);
  if (t.verificationType !== VerificationType.PayerApproval) throw new ToolError("wrong_verification", "task uses artifact-hash verification: deliver the artifact instead");
  if (Number(t.deadline) <= (await d.chain.now())) throw new ToolError("deadline_passed", "release approvals after the deadline are ignored");
  return {
    signer: t.payer.toBase58(), messageUtf8: approvalMessage("release", task).toString("utf-8"),
    submit: { method: "POST", url: new URL(`/v2/tasks/${task.toBase58()}/approvals`, d.evidenceBaseUrl).toString(), body: { action: "release", signer: t.payer.toBase58(), signature: "<hex ed25519 signature of messageUtf8 by signer>" } },
    note: "Only the payer's own signature is accepted. This server cannot sign or release funds.",
  };
}

/** After the deadline: unsigned payer-direct refund (net escrow back to the payer; the fee is not refunded). */
export async function refundTimeoutTask(d: EscrowToolDeps, i: { task: string }) {
  const task = key(i.task, "task"), t = await readTask(d, task);
  if (!t) throw new ToolError("task_not_live", "task is closed or absent");
  if (STATE(t.status) !== "funded") throw new ToolError("task_not_pending", `task is ${TaskStatus[t.status]}`);
  const now = await d.chain.now();
  if (now <= Number(t.deadline)) throw new ToolError("deadline_not_passed", `deadline ${new Date(Number(t.deadline) * 1000).toISOString()} has not passed; before it, a refund is a signed request (payer or callee)`);
  const bh = await d.latestBlockhash();
  const tx = new Transaction({ feePayer: t.payer, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }), buildPayerRefundIx(task, t.payer, ata(t.payer, t.escrowMint)));
  return { task: task.toBase58(), signer: t.payer.toBase58(), unsignedTransactionBase64: unsigned(tx), refundRaw: t.escrowAmount.toString(), feeKeptRaw: (t.protocolFee + t.affiliateFee).toString() };
}

/** Snapshot of one task: live (amounts, parties, deadline) or closed (tombstone terminal status). Read-only. */
export async function getTaskStatus(d: EscrowToolDeps, i: { task: string }) {
  const task = key(i.task, "task"), a = await d.chain.getAccount(task);
  const receipt = { memo: `rufus://${task.toBase58()}`, url: new URL(`/v2/receipts/${task.toBase58()}`, d.evidenceBaseUrl).toString() };
  if (!a || !a.owner.equals(PROGRAM_ID)) return { task: task.toBase58(), state: "absent", receipt };
  try {
    const t = decodeTask(a.data);
    return {
      task: task.toBase58(), state: STATE(t.status), status: TaskStatus[t.status], payer: t.payer.toBase58(), callee: t.calleeAgent.toBase58(), mint: t.escrowMint.toBase58(),
      verification: t.verificationType === VerificationType.PayerApproval ? "payer_approval" : "artifact_hash", deadline: new Date(Number(t.deadline) * 1000).toISOString(),
      amountsRaw: { gross: (t.escrowAmount + t.protocolFee + t.affiliateFee).toString(), escrow: t.escrowAmount.toString(), protocolFee: t.protocolFee.toString(), affiliateFee: t.affiliateFee.toString() },
      receipt,
    };
  } catch {
    try { const tb = decodeTombstone(a.data); return { task: task.toBase58(), state: "terminal", status: tb.terminalStatus, payer: tb.payer.toBase58(), resultHash: tb.resultHash.toString("hex"), closed: true, receipt }; }
    catch { throw new ToolError("unreadable", "account is neither a task nor a tombstone"); }
  }
}

/**
 * Integrator onboarding: an UNSIGNED transaction (authority = fee payer and signer) that registers a DirectWallet
 * IntegratorConfig and the commission token account, so hosts that set this authority as their affiliate pay it
 * 25% of the fee (50 bps) on each task. Never for a payer's own tasks (self-referral is refused at create).
 */
export async function registerIntegrator(d: EscrowToolDeps, i: { authority: string; commissionWallet?: string }) {
  const authority = key(i.authority, "authority"), wallet = i.commissionWallet ? key(i.commissionWallet, "commissionWallet") : authority;
  const o = await integratorOnboarding(d.chain, authority, wallet);
  const { instructions, ...view } = o;
  if (o.status !== "needs_setup") return { ...view, next: o.status === "ready" ? "Already registered. Hosts set SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY to this authority." : "Cannot earn commission with this authority." };
  const bh = await d.latestBlockhash();
  const tx = new Transaction({ feePayer: authority, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }).add(...instructions);
  return { ...view, unsignedTransactionBase64: unsigned(tx), lastValidBlockHeight: bh.lastValidBlockHeight,
    next: "Sign with the authority wallet and send (rent ≈ 0.0027 SOL). Then hosts set SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY to this authority." };
}
