/**
 * Framework-neutral Select escrow tools shared by the SendAI, ElizaOS and Lucid connectors.
 *
 * Trust model:
 *  - Tool inputs come from an LLM and are untrusted data. Schemas are strict (unknown keys rejected);
 *    payer, tenant, cluster, policy and signer are fixed by the host and are not inputs.
 *  - Financial tools never act on inputs alone: create_task takes only the digest of a stored preview,
 *    and every financial action needs a SpendAuthorization returned by the host's `authorize` callback
 *    (a principal's wallet/HSM approval outside the LLM context). No authorization → no action.
 *  - Free-text `description` is stored as a hash for audit and never interpreted.
 */

import { createHash } from "node:crypto";
import type { SpendAuthorization, AuthorizedAction } from "../authorization.js";
import type { RufusEscrowClient } from "../client.js";
import { isFinancialTool, type RufusTool } from "../policy.js";
import type { TaskPreview } from "../preview.js";
import { SETTLEABLE_MINTS } from "../protocol.js";

export interface AuthorizationRequest {
  action: AuthorizedAction;
  wallet: string;
  tenant: string;
  /** Present for create_task: what the principal is approving. */
  preview?: TaskPreview;
  task?: string;
}

export interface ToolkitConfig {
  client: RufusEscrowClient;
  tenant: string;
  cluster: "mainnet-beta" | "devnet" | "localnet";
  /** Payer wallet of the configured signer. */
  wallet: string;
  /** Host-side approval (human or principal signer). Returns null to decline. Never exposed to the LLM. */
  authorize(req: AuthorizationRequest): Promise<SpendAuthorization | null>;
  /** Audit sink for untrusted descriptions (hash only). */
  audit?(event: { tool: string; descriptionSha256?: string; at: number }): void;
}

export interface RufusToolDef {
  name: RufusTool;
  financial: boolean;
  description: string;
  /** Builds a strict schema with the framework's own zod instance (APIs used are identical in zod 3 and 4). */
  schema(z: any): any;
  run(input: any): Promise<Record<string, unknown>>;
}

const TASK = (z: any) => z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

/** Serializes bigint and Buffer values for tool output. */
export function jsonSafe(v: unknown): any {
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return v.toString("hex");
  if (v && typeof v === "object" && typeof (v as any).toBase58 === "function") return (v as any).toBase58();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export function rufusTools(cfg: ToolkitConfig): RufusToolDef[] {
  const previews = new Map<string, TaskPreview>();
  const note = (tool: string, description?: string) =>
    cfg.audit?.({ tool, descriptionSha256: description ? createHash("sha256").update(description).digest("hex") : undefined, at: Date.now() });
  const declined = (what: string) => ({ ok: false, error: "authorization_required", message: `${what} needs approval from the principal outside the agent; nothing was signed or sent.` });

  const defs: Omit<RufusToolDef, "financial">[] = [
    {
      name: "rufus.preview_task",
      description: "Rufus escrow: preview an escrowed task (fee charged at creation, net to the worker, rent, deadline, refund and evidence rules). Read-only; signs nothing.",
      schema: (z) => z.object({
        callee: TASK(z),
        mint: z.enum(Object.keys(SETTLEABLE_MINTS) as [string, ...string[]]),
        amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/).max(32),
        amountBasis: z.enum(["gross", "net"]),
        deadlineSecs: z.number().int().min(60).max(2_592_000),
        verification: z.object({ type: z.enum(["payer_approval", "artifact_hash"]), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        description: z.string().max(500).optional(),
      }).strict(),
      async run(i) {
        note("rufus.preview_task", i.description);
        const verification = i.verification.type === "artifact_hash" ? { type: "artifact_hash" as const, sha256: i.verification.sha256 } : { type: "payer_approval" as const };
        const p = await cfg.client.previewTask({
          cluster: cfg.cluster, tenant: cfg.tenant, payer: cfg.wallet, callee: i.callee, mint: i.mint, amount: i.amount,
          amountBasis: i.amountBasis, deadlineSecs: i.deadlineSecs, verification: verification as any, idempotencyKey: i.idempotencyKey,
        });
        previews.set(p.digest, p);
        return { ok: true, preview: jsonSafe(p), next: p.blocking.length ? "blocked" : "call rufus.create_task with previewDigest after the principal reviews it" };
      },
    },
    {
      name: "rufus.create_task",
      description: "Rufus escrow: create and fund the task from a previous preview (by digest). Requires principal approval outside the agent.",
      schema: (z) => z.object({ previewDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
      async run(i) {
        const p = previews.get(i.previewDigest);
        if (!p) return { ok: false, error: "unknown_preview", message: "preview not found or created by another session" };
        const a = await cfg.authorize({ action: "create_task", wallet: cfg.wallet, tenant: cfg.tenant, preview: p });
        if (!a) return declined("Creating this task");
        return { ok: true, result: jsonSafe(await cfg.client.createTask(p, a)) };
      },
    },
    {
      name: "rufus.get_task",
      description: "Rufus escrow: on-chain task state and local reconciliation state (reported separately). Read-only.",
      schema: (z) => z.object({ task: TASK(z) }).strict(),
      run: async (i) => ({ ok: true, result: jsonSafe(await cfg.client.getTask(i.task)) }),
    },
    {
      name: "rufus.get_receipt",
      description: "Rufus escrow: receipt for a task; final only when backed by a finalized settle/refund transaction. Read-only.",
      schema: (z) => z.object({ task: TASK(z) }).strict(),
      run: async (i) => ({ ok: true, result: jsonSafe(await cfg.client.getReceipt(i.task)) }),
    },
    {
      name: "rufus.request_refund",
      description: "Rufus escrow: request a refund as payer or callee (signed request before the deadline; payer-direct refund after it). The creation fee is not refunded. Requires principal approval.",
      schema: (z) => z.object({ task: TASK(z) }).strict(),
      async run(i) {
        const a = await cfg.authorize({ action: "request_refund", wallet: cfg.wallet, tenant: cfg.tenant, task: i.task });
        if (!a) return declined("Refund");
        return { ok: true, result: jsonSafe(await cfg.client.requestRefund({ task: i.task, authorization: a })) };
      },
    },
    {
      name: "rufus.submit_evidence",
      description: "Rufus escrow: as the payer, sign the release approval for a payer-approval task and send it to the settlement worker. Requires principal approval.",
      schema: (z) => z.object({ task: TASK(z) }).strict(),
      async run(i) {
        const a = await cfg.authorize({ action: "submit_evidence", wallet: cfg.wallet, tenant: cfg.tenant, task: i.task });
        if (!a) return declined("Release approval");
        return { ok: true, result: jsonSafe(await cfg.client.submitEvidence({ task: i.task, kind: "release_approval", authorization: a })) };
      },
    },
  ];
  return defs.map((t) => ({ ...t, financial: isFinancialTool(t.name) }));
}

/** Runs a tool after strict validation; errors become structured results instead of exceptions the LLM might retry blindly. */
export async function runTool(tool: RufusToolDef, z: any, raw: unknown): Promise<Record<string, unknown>> {
  const parsed = tool.schema(z).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input", issues: parsed.error.issues.map((x: any) => `${x.path.join(".")}: ${x.message}`) };
  try { return await tool.run(parsed.data); }
  catch (e: any) { return { ok: false, error: e.code ?? e.name ?? "error", message: String(e.message).slice(0, 500) }; }
}
