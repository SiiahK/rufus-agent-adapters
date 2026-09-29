/**
 * SendAI Solana Agent Kit 2.0.10 plugin: `agent.use(createRufusSakPlugin(cfg))`.
 * Actions are namespaced RUFUS_* with strict zod 3 schemas (the zod major SAK 2.0.10 depends on).
 * The kit's own wallet is not used for Rufus signing; the Rufus client carries its own approved signer.
 */

import { z } from "zod-sak";
import type { Action, Plugin, SolanaAgentKit } from "solana-agent-kit";
import { rufusTools, runTool, type ToolkitConfig } from "./toolkit.js";

const actionName = (tool: string) => tool.replace("rufus.", "RUFUS_").toUpperCase();

export function createRufusSakPlugin(cfg: ToolkitConfig): Plugin {
  const tools = rufusTools(cfg);
  const actions: Action[] = tools.map((t) => ({
    name: actionName(t.name),
    similes: [t.name],
    description: `${t.financial ? "[financial] " : "[read-only] "}${t.description}`,
    examples: [],
    schema: t.schema(z),
    handler: async (_agent: SolanaAgentKit, input: Record<string, any>) => runTool(t, z, input),
  }));
  const methods = Object.fromEntries(tools.map((t) => [
    t.name.replace("rufus.", "rufus_"),
    (_agent: SolanaAgentKit, input: unknown) => runTool(t, z, input),
  ]));
  return {
    name: "rufus-escrow",
    methods,
    actions,
    initialize(_agent: SolanaAgentKit) { /* no kit wallet access needed */ },
  };
}
