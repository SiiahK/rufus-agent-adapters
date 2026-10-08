/**
 * ElizaOS 1.7.2 plugin (independent; not submitted to any registry).
 *
 * Inputs are read only from structured content (`message.content.rufus` or `options.rufus`), never parsed
 * out of free text, so a chat message cannot smuggle amounts, mints or recipients into a financial action.
 * Financial actions validate only for operator entity IDs configured by the host, and still require the
 * host's out-of-band SpendAuthorization in the handler.
 */

import { z } from "zod";
import type { Action, ActionResult, IAgentRuntime, Memory, Plugin, Provider } from "@elizaos/core";
import { rufusTools, runTool, type ToolkitConfig } from "./toolkit.js";

export interface ElizaRufusConfig extends ToolkitConfig {
  /** Entity IDs allowed to trigger financial actions (e.g. the operator's own account). */
  operatorEntityIds: string[];
}

const actionName = (tool: string) => tool.replace("rufus.", "RUFUS_").toUpperCase();

function structuredInput(message: Memory, options?: Record<string, unknown>): unknown {
  const fromOptions = options?.rufus;
  if (fromOptions && typeof fromOptions === "object") return fromOptions;
  const c = message?.content as Record<string, unknown> | undefined;
  return c && typeof c.rufus === "object" ? c.rufus : undefined;
}

export function createRufusElizaPlugin(cfg: ElizaRufusConfig): Plugin {
  const tools = rufusTools(cfg);
  const operators = new Set(cfg.operatorEntityIds);

  const actions: Action[] = tools.map((t) => ({
    name: actionName(t.name),
    similes: [t.name],
    description: `${t.financial ? "[financial] " : "[read-only] "}${t.description} Requires structured input in content.rufus.`,
    validate: async (_runtime: IAgentRuntime, message: Memory) =>
      structuredInput(message) !== undefined && (!t.financial || operators.has(String(message.entityId))),
    handler: async (_runtime: IAgentRuntime, message: Memory, _state?: unknown, options?: Record<string, unknown>, callback?: (c: any) => Promise<Memory[]>): Promise<ActionResult> => {
      if (t.financial && !operators.has(String(message.entityId))) {
        return { success: false, error: "not_operator", text: "Only a configured operator can trigger Select escrow financial actions." };
      }
      const input = structuredInput(message, options);
      if (input === undefined) return { success: false, error: "structured_input_required", text: "Provide content.rufus with the tool input." };
      const result = await runTool(t, z, input);
      const text = result.ok ? `${t.name} ok` : `${t.name} failed: ${String(result.error)}`;
      await callback?.({ text, actions: [actionName(t.name)] });
      return { success: result.ok === true, text, data: result };
    },
  }));

  const policyProvider: Provider = {
    name: "RUFUS_POLICY",
    description: "Select escrow spend policy summary (read-only, host-defined).",
    get: async () => ({
      text: `Select escrow on ${cfg.cluster}: tenant ${cfg.tenant}, payer ${cfg.wallet}. Financial actions require operator approval outside the chat.`,
      values: { rufusCluster: cfg.cluster, rufusTenant: cfg.tenant },
      data: { financialTools: tools.filter((t) => t.financial).map((t) => t.name), readOnlyTools: tools.filter((t) => !t.financial).map((t) => t.name) },
    }),
  };

  return {
    name: "plugin-rufus-escrow",
    description: "Escrow for verifiable tasks between agents on Solana (Select Escrow v2).",
    actions,
    providers: [policyProvider],
  };
}
