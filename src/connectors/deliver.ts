/** Worker-side delivery for artifact-hash tasks, shared by the Lucid connector and the Worker bot. */

import { createHash } from "node:crypto";
import type { RufusEscrowClient } from "../client.js";
import { TaskStatus, VerificationType, type TaskView } from "../protocol.js";

export async function deliverRufusTask(client: RufusEscrowClient, calleeWallet: string, task: string, perform: (task: TaskView, signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal) {
  const view = await client.getTask(task);
  if (view.onChain.kind !== "task") throw new Error("task is closed or absent");
  const t = view.onChain.task;
  if (t.status !== TaskStatus.Funded && t.status !== TaskStatus.Active) throw new Error(`task is ${TaskStatus[t.status]}`);
  if (t.calleeAgent.toBase58() !== calleeWallet) throw new Error("task does not name this agent as callee");
  if (t.verificationType !== VerificationType.ArtifactHash) throw new Error("rufus-deliver only handles artifact-hash tasks");
  if ((await client.now()) > Number(t.deadline)) throw new Error("deadline passed (cluster time)");
  const bytes = await perform(t, signal);
  const digest = createHash("sha256").update(bytes).digest();
  if (!digest.equals(t.verificationData)) return { delivered: false, reason: "output does not match the committed hash; nothing submitted", sha256: digest.toString("hex") };
  const r = await client.submitEvidence({ task, kind: "artifact", bytes });
  return { delivered: r.accepted, status: r.status, sha256: digest.toString("hex") };
}

