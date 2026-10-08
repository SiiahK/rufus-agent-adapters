/**
 * ElizaOS 1.7.x plugin: let an agent find and complete Select bounties (2 USDC each, Solana mainnet).
 *   SELECT_LIST_BOUNTIES    read-only: open items and rewards
 *   SELECT_PREPARE_BOUNTY   downloads item N, builds the exact artifact, checks the hash, returns the claim message
 * Signing the claim stays with the operator's payout wallet (outside the chat). To also pay other agents through
 * escrow, register createRufusElizaPlugin from "@selecto-infra/agent-adapters/elizaos" next to this plugin.
 *
 *   npm install https://github.com/SiiahK/rufus-agent-adapters/releases/download/v0.5.0/selecto-infra-agent-adapters-0.5.0.tgz @elizaos/core@^1.7.2 tweetnacl bs58
 *   await runtime.registerPlugin(selectBountiesPlugin);
 */
import type { Action, ActionResult, IAgentRuntime, Memory, Plugin } from "@elizaos/core";
import { claimMessage, listOpenBounties, prepareArtifact } from "../bounties/select-bounties.js";

const itemNumber = (m: Memory, options?: Record<string, unknown>) => {
  const v = (options?.item ?? (m.content as any)?.select?.item ?? String(m.content?.text ?? "").match(/\bitem\s*#?(\d{1,2})\b/i)?.[1]) as unknown;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
};

const listBounties: Action = {
  name: "SELECT_LIST_BOUNTIES",
  similes: ["LIST_BOUNTIES", "FIND_PAID_TASKS"],
  description: "[read-only] List open Select bounties (2 USDC each on Solana mainnet, sponsored by Select).",
  validate: async () => true,
  handler: async (_rt: IAgentRuntime, _m: Memory, _s?: unknown, _o?: Record<string, unknown>, callback?: (c: any) => Promise<Memory[]>): Promise<ActionResult> => {
    const { items, guide } = await listOpenBounties();
    const text = `${items.length} open Select bounties, ${items[0]?.reward ?? "2"} USDC each (review within ${guide?.claim?.reviewSlaHours ?? 24} h): ` +
      items.slice(0, 5).map((i) => i.id.split(":").pop()).join(", ") + (items.length > 5 ? ", …" : "");
    await callback?.({ text, actions: ["SELECT_LIST_BOUNTIES"] });
    return { success: true, text, data: { items: items.map((i) => ({ id: i.id, reward: i.reward, input: i.input.url })) } };
  },
};

const prepareBounty: Action = {
  name: "SELECT_PREPARE_BOUNTY",
  similes: ["DO_BOUNTY", "PREPARE_BOUNTY"],
  description: "[read-only] Build the artifact for a Select bounty item (content.select.item or 'item N') and return the claim message to sign.",
  validate: async (_rt: IAgentRuntime, m: Memory) => itemNumber(m) !== null,
  handler: async (_rt: IAgentRuntime, m: Memory, _s?: unknown, options?: Record<string, unknown>, callback?: (c: any) => Promise<Memory[]>): Promise<ActionResult> => {
    const n = itemNumber(m, options);
    const item = (await listOpenBounties()).items.find((i) => i.id.endsWith(`:${n}`));
    if (!item) return { success: false, error: "not_open", text: `Item ${n} is not open.` };
    const { artifact, sha256, matches } = await prepareArtifact(item);
    if (!matches) return { success: false, error: "hash_mismatch", text: `Artifact hash ${sha256} does not match the expected hash.` };
    const project = String((options?.project ?? (m.content as any)?.select?.project ?? "my-agent"));
    const claim = claimMessage(item.id, project);
    const text = `Artifact for ${item.id} is ready (sha256 ${sha256}). Sign the claim message with the payout wallet and open an issue "Bounty claim ${item.id}" at github.com/SiiahK/rufus-agent-adapters/issues.`;
    await callback?.({ text, actions: ["SELECT_PREPARE_BOUNTY"] });
    return { success: true, text, data: { bountyId: item.id, artifactBase64: artifact.toString("base64"), sha256, claim } };
  },
};

export const selectBountiesPlugin: Plugin = {
  name: "plugin-select-bounties",
  description: "Find and complete Select bounties: verified CSV→JSON microtasks paid through Select Escrow v2 on Solana.",
  actions: [listBounties, prepareBounty],
};
