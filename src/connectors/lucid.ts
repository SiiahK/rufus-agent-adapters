/**
 * Lucid Agents (core 5.0.0 + a2a 2.0.0) integration.
 *
 * Select escrow is the payment rail here, so no Lucid payments/x402 extension is installed: charging x402 on
 * top of an escrowed obligation would bill the same work twice. Lucid's own docs separate Solana seller-side
 * verification from EVM buyer flows; this module does not assume a Lucid Solana buyer.
 *
 * Entrypoints:
 *   rufus-preview / rufus-task-status / rufus-receipt    read-only
 *   rufus-deliver    worker (callee) side, run as an A2A async task: verifies on-chain that the task is funded,
 *                    names this agent as callee and commits to an artifact hash; produces the artifact with the
 *                    host's `perform` function; submits it only if its SHA-256 matches the commitment.
 * Task state uses the a2a TaskStore; the default in-memory store is process-local (restarts lose task
 * records, never funds). Inject a durable store for production.
 */

import { randomBytes } from "node:crypto";
// Schemas must come from the zod build @lucid-agents/core 5.0.0 bundles (4.4.3): its manifest serializer
// walks zod internals, which differ across minor versions. Types are cast because @lucid-agents/types
// resolves a different zod for its declarations.
import { z } from "zod-lucid";
import { createAgent, buildAgentManifest, type EntrypointDef } from "@lucid-agents/core";
import { a2a } from "@lucid-agents/a2a";
import type { TaskStore } from "@lucid-agents/types/a2a";
import type { RufusEscrowClient } from "../client.js";
import type { TaskView } from "../protocol.js";
import { deliverRufusTask } from "./deliver.js";
import { jsonSafe, rufusTools, runTool, type ToolkitConfig } from "./toolkit.js";

export interface LucidRufusConfig extends ToolkitConfig {
  /** This agent's callee wallet (the one Select escrow tasks name as callee_agent). */
  calleeWallet: string;
  /** Produces the deliverable for a verified task. Runs with the task's untrusted metadata as data only. */
  perform(task: TaskView, signal: AbortSignal): Promise<Uint8Array>;
  store?: TaskStore;
  maxRunMs?: number;
}

export { deliverRufusTask };

const TASK = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export function rufusLucidEntrypoints(cfg: LucidRufusConfig): EntrypointDef[] {
  const tools = Object.fromEntries(rufusTools(cfg).map((t) => [t.name, t]));
  const readOnly = (key: string, tool: string, description: string): EntrypointDef => ({
    key, description, input: tools[tool].schema(z) as any, output: z.record(z.string(), z.unknown()) as any,
    metadata: { rufus: { tool, financial: false } },
    handler: async (ctx) => ({ output: await runTool(tools[tool], z, ctx.input) }),
  });
  return [
    readOnly("rufus-preview", "rufus.preview_task", "Preview a Rufus escrow task: fee at creation, net to worker, rent, deadline and refund rules."),
    readOnly("rufus-task-status", "rufus.get_task", "On-chain task state and reconciliation state, separately."),
    readOnly("rufus-receipt", "rufus.get_receipt", "Receipt for a task; final only with a finalized settle/refund transaction."),
    {
      key: "rufus-deliver",
      description: "Worker side: deliver the committed artifact for a funded Rufus task that names this agent as callee. Returns an A2A task handle.",
      input: z.object({ task: TASK }).strict() as any,
      output: z.record(z.string(), z.unknown()) as any,
      metadata: { rufus: { role: "callee", async: true } },
      handler: async (ctx) => {
        const rt = ctx.runtime as any;
        const accessToken = randomBytes(24).toString("hex");
        const taskId = `rufus-deliver:${(ctx.input as { task: string }).task}`;
        const handle = await rt.a2a.tasks.start({
          taskId, accessToken,
          execute: async (signal: AbortSignal) => ({ output: jsonSafe(await deliverRufusTask(cfg.client, cfg.calleeWallet, (ctx.input as { task: string }).task, cfg.perform, signal)) }),
          mapError: (e: unknown) => ({ code: "rufus_deliver_failed", message: String((e as Error)?.message ?? e).slice(0, 300) }),
        });
        return { output: { a2aTaskId: handle.taskId, status: handle.status, accessToken } };
      },
    },
  ];
}

/** Builds a Lucid agent runtime with the a2a extension and the Select escrow entrypoints. */
export async function createRufusLucidAgent(cfg: LucidRufusConfig, meta = { name: "rufus-escrow-worker", version: "0.1.0", description: "Escrow for verifiable tasks between agents on Solana (Rufus v2)." }) {
  let builder: any = createAgent(meta).use(a2a({ tasks: { store: cfg.store, maxRunMs: cfg.maxRunMs ?? 120_000 } }));
  for (const e of rufusLucidEntrypoints(cfg)) builder = builder.addEntrypoint(e);
  const runtime = await builder.build();
  return { runtime, manifest: (origin: string) => buildAgentManifest({ meta, registry: runtime.entrypoints.snapshot(), origin }) };
}
