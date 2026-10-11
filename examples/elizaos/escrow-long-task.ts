/**
 * ElizaOS (core 1.7.2): hold USDC in Select Escrow for a long job (report, scrape, dataset) until it is delivered.
 * Independent example, not an official ElizaOS plugin.
 *
 * Flow:
 *  1. the agent funds an escrow task for the provider (createTaskEscrow, host authorization required);
 *  2. it schedules a background task (ElizaOS task worker) that checks the escrow's state once per run;
 *  3. when the host's accept() says the delivery is acceptable, the worker approves the release (payer approval);
 *     after the deadline without an accepted delivery, it refunds (the 2% fee is not refunded).
 * Every financial step goes through authorize(): the host's approval (a human or a policy service), never the model.
 * Scheduling: the runtime's task service runs the worker; metadata.updateInterval follows the ElizaOS
 * "Background Tasks" guide (https://docs.elizaos.ai/guides/background-tasks.md). Types checked against core 1.7.2.
 */
import type { IAgentRuntime, TaskWorker, UUID } from "@elizaos/core";
import type { HostAuthorize, RufusEscrowClient } from "@selecto-infra/agent-adapters/core";

export interface LongJobDeps {
  client: RufusEscrowClient;
  authorize: HostAuthorize;
  /** Host-side acceptance of the delivery for this job (e.g. checks the file, the dataset size, a human review). */
  accept(job: { key: string; task: string }): Promise<"accepted" | "rejected" | "pending">;
  apiOrigin?: string;
}

const WORKER = "SELECT_AWAIT_DELIVERY";

/** Registers the worker that settles long jobs; call once from your plugin's init(). */
export function registerEscrowWorker(runtime: IAgentRuntime, d: LongJobDeps) {
  const api = d.apiOrigin ?? "https://api.tryaigility.com";
  const worker: TaskWorker = {
    name: WORKER,
    async execute(_rt, _options, task) {
      const m = (task.metadata ?? {}) as { key?: string; task?: string; provider?: string };
      if (!m.key || !m.task || !m.provider) return;
      const s = await (await fetch(`${api}/v2/tasks/${m.task}/settlement`)).json() as { status?: string; deadline?: number };
      if (s.status !== "Funded" && s.status !== "Active") { if (task.id) await runtime.deleteTask(task.id); return; }   // already settled or refunded
      const verdict = await d.accept({ key: m.key, task: m.task });
      if (verdict === "accepted") await d.client.releaseTaskEscrow({ taskId: m.key, providerPubkey: m.provider, authorize: d.authorize });
      else if (verdict === "rejected" || (s.deadline && Date.now() / 1000 > s.deadline)) await d.client.refundTaskEscrow({ taskId: m.key, authorize: d.authorize });
      // "pending" before the deadline: nothing to do; the next run checks again.
    },
  };
  runtime.registerTaskWorker(worker);
}

/** Funds a long job for `provider` and schedules its settlement checks (every `everyMs`, default 10 minutes). */
export async function holdUntilDelivered(runtime: IAgentRuntime, d: LongJobDeps,
  job: { key: string; provider: string; amountUsdc: string; timeoutSeconds: number; roomId?: UUID; everyMs?: number }) {
  const funded = await d.client.createTaskEscrow({ amount: job.amountUsdc, taskId: job.key, providerPubkey: job.provider, timeoutSeconds: job.timeoutSeconds, authorize: d.authorize });
  await runtime.createTask({
    name: WORKER,
    description: `Settle Select escrow ${funded.task} when the delivery for ${job.key} is accepted`,
    roomId: job.roomId,
    tags: ["select-escrow", "scheduled"],
    metadata: { key: job.key, task: funded.task, provider: job.provider, updateInterval: job.everyMs ?? 10 * 60 * 1000 },
  });
  return funded.task;
}
