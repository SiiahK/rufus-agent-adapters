/**
 * RufusEscrowClient — the common adapter every connector wraps.
 *
 *   previewTask → createTask (policy + authorization + preview digest, simulate, persist-before-send)
 *   getTask (on-chain state and local reconciliation state, separately)
 *   submitEvidence (payer release approval / committed artifact → the settlement worker's evidence intake)
 *   requestRefund (signed refund request before the deadline; payer-direct refund_task_v2 after it)
 *   getReceipt (only "finalized" when backed by a finalized settle/refund signature)
 *
 * There is no approveRelease on-chain instruction: release is executed by the registered executor
 * when the worker verifies the evidence. The adapter never claims more authority than the program grants.
 *
 * Unified helpers: createTaskEscrow / releaseTaskEscrow / refundTaskEscrow wrap the steps above with the host's
 * authorize() callback. The integrator (affiliate) is host configuration only (option or environment, see
 * affiliate.ts); a creation carries it only when it is a valid DirectWallet integrator, never the payer.
 */

import { createHash } from "node:crypto";
import bs58 from "bs58";
import { ComputeBudgetProgram, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { verifyAuthorization, type AuthorizedAction, type NonceStore, type SpendAuthorization, type TenantRegistry } from "./authorization.js";
import { affiliateFromEnv, resolveAffiliate, type AffiliateRoute } from "./affiliate.js";
import type { ChainReader, TaskSigner, TxSender } from "./chain.js";
import { checkSpend, type AgentSpendPolicy, type BudgetTracker, type Cluster } from "./policy.js";
import { bindingDigest, clientOperationId, previewTask, type PreviewInput, type TaskPreview, type WorkerPolicy } from "./preview.js";
import {
  PROGRAM_ID, TaskStatus, VerificationType, approvalMessage, ata, buildCreateTaskIx, buildPayerRefundIx, buildRegisterIntegratorIx,
  configPda, decodeProtocolConfig, decodeTask, decodeTombstone, integratorPda, resolveRoutingDomain, taskPda, USDC_MINT, DEFAULT_DOMAIN, type TaskView, type TombstoneView,
} from "./protocol.js";

/** Host-side approval for the unified helpers (same contract as the connectors' authorize callback). */
export type HostAuthorize = (req: { action: AuthorizedAction; wallet: string; tenant: string; preview?: TaskPreview; task?: string }) => Promise<SpendAuthorization | null>;

export type ReconciliationState = "reserved" | "signed" | "submitted" | "uncertain" | "finalized" | "failed_final" | "cancelled_before_send";

export interface JournalEntry { task: string; state: ReconciliationState; signature?: string; lastValidBlockHeight?: number; updatedAt: number; detail?: string; }

/** Local record of what this client did; persisted before the first send. */
export interface OperationJournal { get(task: string): JournalEntry | undefined; put(e: JournalEntry): void; }

export function memoryJournal(): OperationJournal {
  const m = new Map<string, JournalEntry>();
  return { get: (t) => m.get(t), put: (e) => { m.set(e.task, { ...e }); } };
}

export interface FinalizedSignatureSource {
  /** Finalized, successful program transactions touching the task (from the receipts indexer). */
  finalizedSignatures(task: string): Promise<{ signature: string; kind: "create" | "settle" | "refund" | "close"; slot: number }[]>;
}

export class ClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ClientError"; }
}

export interface ClientOptions {
  cluster: Cluster;
  chain: ChainReader;
  policy: AgentSpendPolicy;
  registry: TenantRegistry;
  nonces: NonceStore;
  budget: BudgetTracker;
  journal?: OperationJournal;
  signer?: TaskSigner;
  sender?: TxSender;
  /** Settlement worker evidence intake, e.g. https://api.example/ (POST /v2/tasks/<task>/…, GET /health). */
  evidenceBaseUrl?: string;
  fetch?: typeof fetch;
  receipts?: FinalizedSignatureSource;
  confirmPolls?: number;
  pollDelayMs?: number;
  /** Integrator authority receiving 25% of the fee when valid. undefined → read SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY / RUFUS_AFFILIATE_PUBKEY; null → none. */
  affiliate?: string | null;
  /** Tenant used by the unified helpers (default "default"). */
  tenant?: string;
  /** Routing domain for new tasks. undefined → RUFUS_ROUTING_DOMAIN, else "payments_v2". It is bound into the preview digest. */
  domain?: string;
}

export class RufusEscrowClient {
  private readonly journal: OperationJournal;
  /** Affiliate chosen by the host (option or environment); validated on-chain at each creation. */
  readonly affiliate: string | null;
  /** Routing domain used for new tasks. */
  readonly domain: string;
  constructor(private readonly o: ClientOptions) {
    this.domain = resolveRoutingDomain(o.domain);
    this.journal = o.journal ?? memoryJournal();
    Object.freeze(this.o.policy);
    this.affiliate = o.affiliate === undefined ? affiliateFromEnv() : o.affiliate === null ? null : new PublicKey(o.affiliate).toBase58();
  }

  /** Cluster time used for every deadline decision (never the local wall clock). */
  now(): Promise<number> { return this.o.chain.now(); }

  /** Read-only. */
  async workerPolicy(): Promise<WorkerPolicy | null> {
    if (!this.o.evidenceBaseUrl) return null;
    try {
      const r = await (this.o.fetch ?? fetch)(new URL("/health", this.o.evidenceBaseUrl), { signal: AbortSignal.timeout(5_000), redirect: "error" });
      const h = await r.json() as { policy?: WorkerPolicy };
      return h.policy ?? null;
    } catch { return null; }
  }

  /** Read-only. */
  async previewTask(input: PreviewInput): Promise<TaskPreview> {
    checkSpend(this.o.policy, { tool: "rufus.preview_task", cluster: input.cluster, mint: input.mint, callee: input.callee, grossRaw: 0n, deadlineSecsFromNow: input.deadlineSecs }, 0n);
    return previewTask({ ...input, domain: input.domain ?? this.domain }, this.o.chain, { workerPolicy: await this.workerPolicy() });
  }

  async createTask(preview: TaskPreview, authorization: SpendAuthorization, opts: { affiliate?: string | null } = {}): Promise<{ task: string; state: ReconciliationState | "already_exists"; signature?: string; commission?: AffiliateRoute }> {
    const { signer, sender } = this.need();
    const b = preview.binding;
    const now = await this.o.chain.now();
    if (preview.version !== "rufus.preview.v1") throw new ClientError("preview_version", "unsupported preview version");
    if (bindingDigest(b, preview.createdAt, preview.expiresAt) !== preview.digest) throw new ClientError("preview_tampered", "preview digest does not match its parameters");
    if (now > preview.expiresAt) throw new ClientError("preview_expired", "preview expired; request a new one");
    if (b.cluster !== this.o.cluster) throw new ClientError("wrong_cluster", "preview is for another cluster");
    if (preview.blocking.length > 0) throw new ClientError("preview_blocked", preview.blocking.join("; "));
    if (b.payer !== signer.publicKey.toBase58()) throw new ClientError("wrong_signer", "signer is not the previewed payer");
    const gross = BigInt(b.grossRaw);

    checkSpend(this.o.policy, { tool: "rufus.create_task", cluster: b.cluster, mint: b.mint, callee: b.callee, grossRaw: gross, deadlineSecsFromNow: b.deadline - now }, this.o.budget.authorized(b.mint));
    verifyAuthorization(authorization, { cluster: this.o.cluster, wallet: b.payer, action: "create_task", mint: b.mint, grossRaw: gross, previewDigest: preview.digest, now }, this.o.registry, this.o.nonces);

    const prior = this.journal.get(b.task);
    if (prior && prior.state !== "cancelled_before_send" && prior.state !== "failed_final" && prior.state !== "reserved") {
      return { task: b.task, state: prior.state, signature: prior.signature };
    }
    if (await this.o.chain.getAccount(new PublicKey(b.task))) return { task: b.task, state: "already_exists" };

    const cap = BigInt(this.o.policy.mints[b.mint].budgetRaw);
    if (!this.o.budget.reserve(b.task, b.mint, gross, cap)) throw new ClientError("budget_cap", "cumulative authorization budget exhausted");
    this.journal.put({ task: b.task, state: "reserved", updatedAt: now });

    const cfgAcct = await this.o.chain.getAccount(configPda());
    const cfg = decodeProtocolConfig(cfgAcct!.data);
    if (cfg.protocolFeeBps.toString() !== b.feeBps) {
      this.cancel(b.task, now, "fee changed since preview");
      throw new ClientError("fee_changed", "on-chain fee differs from the preview");
    }
    const { ixs, route } = await buildCreateInstructions(this.o.chain, preview, signer.publicKey, opts.affiliate === undefined ? this.affiliate : opts.affiliate, cfg.treasuryAuthority);
    return { ...(await this.signAndSend(b.task, ixs, now)), commission: route };
  }

  // ── unified helpers ──────────────────────────────────────

  /** Task address for a taskId (idempotency key) of this payer and tenant. */
  taskAddress(taskId: string, tenant = this.o.tenant ?? "default"): string {
    const { signer } = this.need(false);
    return taskPda(signer.publicKey, clientOperationId(tenant, signer.publicKey.toBase58(), taskId)).toBase58();
  }

  /** preview → host authorization → create. `amount` is the gross in decimal units of the mint (default USDC). */
  async createTaskEscrow(p: {
    amount: string; taskId: string; providerPubkey: string; timeoutSeconds: number; affiliatePubkey?: string | null;
    mint?: string; verification?: PreviewInput["verification"]; tenant?: string; authorize: HostAuthorize;
  }) {
    const { signer } = this.need();
    const tenant = p.tenant ?? this.o.tenant ?? "default", wallet = signer.publicKey.toBase58();
    const preview = await this.previewTask({
      cluster: this.o.cluster, tenant, payer: wallet, callee: p.providerPubkey, mint: p.mint ?? USDC_MINT.toBase58(), amount: p.amount, amountBasis: "gross",
      deadlineSecs: p.timeoutSeconds, verification: p.verification ?? { type: "payer_approval" }, idempotencyKey: p.taskId,
    });
    const auth = await p.authorize({ action: "create_task", wallet, tenant, preview });
    if (!auth) throw new ClientError("authorization_required", "the host declined or did not authorize this payment");
    return { preview, ...(await this.createTask(preview, auth, { affiliate: p.affiliatePubkey })) };
  }

  /** Payer's release approval for the provider named at creation; the executor settles after verifying it. */
  async releaseTaskEscrow(p: { taskId: string; providerPubkey: string; tenant?: string; authorize: HostAuthorize }) {
    const { signer } = this.need(false);
    const tenant = p.tenant ?? this.o.tenant ?? "default", task = this.taskAddress(p.taskId, tenant);
    const t = await this.liveTask(task);
    if (t.calleeAgent.toBase58() !== new PublicKey(p.providerPubkey).toBase58()) throw new ClientError("wrong_provider", "providerPubkey is not the task's callee");
    const auth = await p.authorize({ action: "submit_evidence", wallet: signer.publicKey.toBase58(), tenant, task });
    if (!auth) throw new ClientError("authorization_required", "the host declined or did not authorize this release");
    return { task, ...(await this.submitEvidence({ task, kind: "release_approval", authorization: auth })) };
  }

  /** Signed refund request before the deadline; payer-direct refund after it. The fee is not refunded. */
  async refundTaskEscrow(p: { taskId: string; tenant?: string; authorize: HostAuthorize }) {
    const { signer } = this.need(false);
    const tenant = p.tenant ?? this.o.tenant ?? "default", task = this.taskAddress(p.taskId, tenant);
    const auth = await p.authorize({ action: "request_refund", wallet: signer.publicKey.toBase58(), tenant, task });
    if (!auth) throw new ClientError("authorization_required", "the host declined or did not authorize this refund");
    return { task, ...(await this.requestRefund({ task, authorization: auth })) };
  }

  /** On-chain state and local reconciliation state are reported separately and never merged. */
  async getTask(task: string): Promise<{ task: string; onChain: { kind: "task"; task: TaskView } | { kind: "tombstone"; tombstone: TombstoneView } | { kind: "absent" }; reconciliation: JournalEntry | null }> {
    const key = new PublicKey(task);
    const a = await this.o.chain.getAccount(key);
    let onChain: { kind: "task"; task: TaskView } | { kind: "tombstone"; tombstone: TombstoneView } | { kind: "absent" } = { kind: "absent" };
    if (a && a.owner.equals(PROGRAM_ID)) {
      try { onChain = { kind: "task", task: decodeTask(a.data) }; }
      catch { onChain = { kind: "tombstone", tombstone: decodeTombstone(a.data) }; }
    }
    return { task: key.toBase58(), onChain, reconciliation: this.journal.get(key.toBase58()) ?? null };
  }

  async submitEvidence(req: { task: string; kind: "release_approval"; authorization: SpendAuthorization } | { task: string; kind: "artifact"; bytes: Uint8Array }): Promise<{ accepted: boolean; status: number; body: unknown }> {
    const t = await this.liveTask(req.task);
    const now = await this.o.chain.now();
    if (now > Number(t.deadline)) throw new ClientError("deadline_passed", "evidence after the deadline is ignored by the worker");
    checkSpend(this.o.policy, { tool: "rufus.submit_evidence", cluster: this.o.cluster, mint: t.escrowMint.toBase58(), callee: t.calleeAgent.toBase58(), grossRaw: 0n, deadlineSecsFromNow: this.o.policy.minDeadlineSecs }, 0n);
    if (req.kind === "artifact") {
      if (t.verificationType !== VerificationType.ArtifactHash) throw new ClientError("wrong_verification", "task does not use artifact-hash verification");
      const digest = createHash("sha256").update(req.bytes).digest();
      if (!digest.equals(t.verificationData)) throw new ClientError("hash_mismatch", "artifact does not match the committed hash; not sent");
      return this.post(`/v2/tasks/${req.task}/artifact`, Buffer.from(req.bytes), "application/octet-stream");
    }
    const { signer } = this.need(false);
    if (t.verificationType !== VerificationType.PayerApproval) throw new ClientError("wrong_verification", "task does not use payer approval");
    if (!signer.publicKey.equals(t.payer)) throw new ClientError("not_payer", "only the task payer can approve release");
    verifyAuthorization(req.authorization, { cluster: this.o.cluster, wallet: t.payer.toBase58(), action: "submit_evidence", task: req.task, now }, this.o.registry, this.o.nonces);
    const sig = await signer.signMessage(approvalMessage("release", new PublicKey(req.task)));
    return this.post(`/v2/tasks/${req.task}/approvals`, Buffer.from(JSON.stringify({ action: "release", signer: signer.publicKey.toBase58(), signature: Buffer.from(sig).toString("hex") })), "application/json");
  }

  async requestRefund(req: { task: string; authorization: SpendAuthorization }): Promise<{ path: "signed_request" | "payer_direct"; result: unknown }> {
    const { signer } = this.need(false);
    const t = await this.liveTask(req.task);
    const now = await this.o.chain.now();
    const me = signer.publicKey;
    if (!me.equals(t.payer) && !me.equals(t.calleeAgent)) throw new ClientError("not_party", "only the payer or the callee can request a refund");
    checkSpend(this.o.policy, { tool: "rufus.request_refund", cluster: this.o.cluster, mint: t.escrowMint.toBase58(), callee: t.calleeAgent.toBase58(), grossRaw: 0n, deadlineSecsFromNow: this.o.policy.minDeadlineSecs }, 0n);
    verifyAuthorization(req.authorization, { cluster: this.o.cluster, wallet: me.toBase58(), action: "request_refund", task: req.task, now }, this.o.registry, this.o.nonces);
    if (me.equals(t.payer) && now > Number(t.deadline)) {
      const r = await this.signAndSend(req.task, [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
        buildPayerRefundIx(new PublicKey(req.task), me, ata(me, t.escrowMint)),
      ], now, true);
      return { path: "payer_direct", result: r };
    }
    const sig = await signer.signMessage(approvalMessage("refund", new PublicKey(req.task)));
    return { path: "signed_request", result: await this.post(`/v2/tasks/${req.task}/approvals`, Buffer.from(JSON.stringify({ action: "refund", signer: me.toBase58(), signature: Buffer.from(sig).toString("hex") })), "application/json") };
  }

  async getReceipt(task: string) {
    const view = await this.getTask(task);
    const sigs = this.o.receipts ? await this.o.receipts.finalizedSignatures(task) : [];
    const terminal = sigs.find((s) => s.kind === "settle" || s.kind === "refund");
    const base = { task, programId: PROGRAM_ID.toBase58(), cluster: this.o.cluster, signatures: sigs };
    if (view.onChain.kind === "task") {
      const t = view.onChain.task;
      const isTerminal = [TaskStatus.Completed, TaskStatus.Refunded, TaskStatus.Cancelled].includes(t.status);
      return {
        ...base, finality: isTerminal && terminal ? "finalized" as const : "not_final" as const, status: TaskStatus[t.status],
        mint: t.escrowMint.toBase58(), netEscrowRaw: t.escrowAmount.toString(), protocolFeeRaw: t.protocolFee.toString(), affiliateFeeRaw: t.affiliateFee.toString(),
        grossRaw: (t.escrowAmount + t.protocolFee + t.affiliateFee).toString(), resultHash: t.resultHash.toString("hex"),
      };
    }
    if (view.onChain.kind === "tombstone") {
      return { ...base, finality: terminal ? "finalized" as const : "not_final" as const, status: view.onChain.tombstone.terminalStatus, closed: true, resultHash: view.onChain.tombstone.resultHash.toString("hex"), amounts: "from indexer events only" };
    }
    return { ...base, finality: "not_final" as const, status: "absent" };
  }

  /** Resolves submitted/uncertain operations without sending anything new. */
  async reconcile(task: string): Promise<JournalEntry> {
    const { sender } = this.need();
    const e = this.journal.get(task);
    if (!e || !e.signature || e.state === "finalized" || e.state === "failed_final") return e ?? { task, state: "cancelled_before_send", updatedAt: await this.o.chain.now() };
    const now = await this.o.chain.now();
    const st = await sender.signatureStatus(e.signature).catch(() => null);
    if (st?.err) return this.mark(e, "failed_final", now, "transaction failed on-chain");
    if (st?.confirmationStatus === "finalized") return this.mark(e, "finalized", now);
    if (st) return this.mark(e, "submitted", now, `seen at ${st.confirmationStatus}`);
    const height = await sender.blockHeight().catch(() => null);
    if (height !== null && e.lastValidBlockHeight !== undefined && height > e.lastValidBlockHeight) {
      // Blockhash expired and the signature is unknown: check the economic state before declaring failure.
      if (await this.o.chain.getAccount(new PublicKey(task.split(":")[0]))) return this.mark(e, "uncertain", now, "task exists on-chain but signature unseen; indexer must confirm");
      return this.mark(e, "failed_final", now, "blockhash expired, no signature and no task account");
    }
    return this.mark(e, "uncertain", now, "signature not yet visible");
  }

  // ── internals ────────────────────────────────────────────

  private need(withSender = true): { signer: TaskSigner; sender: TxSender } {
    if (!this.o.signer) throw new ClientError("no_signer", "this client is read-only (no signer configured)");
    if (withSender && !this.o.sender) throw new ClientError("no_sender", "no transaction sender configured");
    return { signer: this.o.signer, sender: this.o.sender! };
  }

  private cancel(task: string, now: number, detail: string) {
    this.o.budget.releaseUnsent(task);
    this.journal.put({ task, state: "cancelled_before_send", updatedAt: now, detail });
  }

  private mark(e: JournalEntry, state: ReconciliationState, now: number, detail?: string): JournalEntry {
    const next = { ...e, state, updatedAt: now, detail };
    this.journal.put(next);
    return next;
  }

  private async liveTask(task: string): Promise<TaskView> {
    const v = await this.getTask(task);
    if (v.onChain.kind !== "task") throw new ClientError("task_not_live", "task is closed or absent");
    const t = v.onChain.task;
    if (t.status !== TaskStatus.Funded && t.status !== TaskStatus.Active) throw new ClientError("task_not_pending", `task is ${TaskStatus[t.status]}`);
    return t;
  }

  private async signAndSend(task: string, ixs: TransactionInstruction[], now: number, isRefund = false) {
    const { signer, sender } = this.need();
    let tx: Transaction, lastValidBlockHeight: number, sim: Awaited<ReturnType<TxSender["simulate"]>>;
    try {
      const bh = await sender.latestBlockhash();
      lastValidBlockHeight = bh.lastValidBlockHeight;
      tx = new Transaction({ feePayer: signer.publicKey, blockhash: bh.blockhash, lastValidBlockHeight }).add(...ixs);
      sim = await sender.simulate(tx);
    } catch (e) {
      // Nothing was signed: release the reservation so a retry can proceed.
      if (!isRefund) this.cancel(task, now, `rpc before signing: ${(e as Error).message}`);
      throw e;
    }
    if (!sim.ok) {
      if (!isRefund) this.cancel(task, now, "simulation failed");
      throw new ClientError("simulation_failed", `simulation failed: ${JSON.stringify(sim.err)} ${sim.logs.slice(-3).join(" | ")}`);
    }
    const signed = await signer.signTransaction(tx);
    const signature = signed.signatures[0]?.signature ? bs58sig(signed.signatures[0].signature) : "";
    const key = isRefund ? `${task}:refund` : task;
    // Persist the signature before the first send: a crash after this point is reconciled, never re-bought.
    this.journal.put({ task: key, state: "signed", signature, lastValidBlockHeight, updatedAt: now });
    try {
      await sender.send(signed.serialize());
      this.journal.put({ task: key, state: "submitted", signature, lastValidBlockHeight, updatedAt: now });
    } catch (e) {
      this.journal.put({ task: key, state: "uncertain", signature, lastValidBlockHeight, updatedAt: now, detail: (e as Error).message });
      return { task, state: "uncertain" as const, signature };
    }
    for (let i = 0; i < (this.o.confirmPolls ?? 30); i++) {
      const e = await this.reconcile(key);
      if (e.state === "finalized" || e.state === "failed_final") return { task, state: e.state, signature };
      await new Promise((r) => setTimeout(r, this.o.pollDelayMs ?? 2_000));
    }
    return { task, state: this.journal.get(key)!.state, signature };
  }

  private async post(path: string, body: Buffer, contentType: string) {
    if (!this.o.evidenceBaseUrl) throw new ClientError("no_evidence_endpoint", "evidenceBaseUrl not configured");
    const r = await (this.o.fetch ?? fetch)(new URL(path, this.o.evidenceBaseUrl), {
      method: "POST", headers: { "Content-Type": contentType }, body: new Uint8Array(body), signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { accepted: r.status === 202, status: r.status, body: parsed };
  }
}

/**
 * Instructions for create_task_v2 from a verified preview. Commission route: a valid third-party DirectWallet
 * integrator, or the treasury — never the payer. Shared by the client and by servers that return unsigned
 * transactions (the MCP server), so both build byte-identical instructions.
 */
export async function buildCreateInstructions(chain: ChainReader, preview: TaskPreview, payer: PublicKey, affiliate: string | null, treasuryAuthority: PublicKey): Promise<{ ixs: TransactionInstruction[]; route: AffiliateRoute }> {
  const b = preview.binding, mint = new PublicKey(b.mint);
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: b.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: b.priorityFeeMicroLamports }),
  ];
  const route = await resolveAffiliate(chain, affiliate, payer, mint);
  let integratorConfig: PublicKey, affiliateTokenAccount: PublicKey | undefined;
  if (route.kind === "affiliate") { integratorConfig = route.integratorConfig; affiliateTokenAccount = route.affiliateTokenAccount; }
  else {
    integratorConfig = integratorPda(payer);
    if (!(await chain.getAccount(integratorConfig))) ixs.push(buildRegisterIntegratorIx(payer, payer));
  }
  ixs.push(buildCreateTaskIx({
    payer, callee: new PublicKey(b.callee), mint, grossAmount: BigInt(b.grossRaw), deadline: BigInt(b.deadline),
    clientOperationId: Buffer.from(b.clientOperationId, "hex"), verificationType: b.verificationType,
    verificationData: Buffer.from(b.verificationData, "hex"), integratorConfig,
    treasuryTokenAccount: ata(treasuryAuthority, mint), affiliateTokenAccount, domain: b.domain ?? DEFAULT_DOMAIN,
  }));
  return { ixs, route };
}

const bs58sig = (b: Buffer | Uint8Array) => bs58.encode(b);
