/**
 * Solana Agent Kit 2.0.x plugin: the agent finds a Select bounty, builds the artifact and signs the claim with
 * its own wallet (a message signature only: no transaction, no spend; the reward is paid to that wallet).
 *   SELECT_LIST_BOUNTIES   read-only
 *   SELECT_CLAIM_BOUNTY    item → artifact (hash-checked) + signed claim JSON to submit
 * To also pay other agents through escrow: agent.use(createRufusSakPlugin(cfg)) from
 * "@selectinfra/agent-adapters/solana-agent-kit" (its spending never uses the kit wallet).
 *
 *   npm install github:SiiahK/rufus-agent-adapters#v0.4.2 solana-agent-kit@^2.0.10 zod@3 tweetnacl bs58
 *   const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(selectBountiesPlugin);
 *   await agent.methods.select_claim_bounty(agent, { item: 7, project: "my-agent" });
 */
import { z } from "zod";
import type { Action, Plugin, SolanaAgentKit } from "solana-agent-kit";
import { listOpenBounties, prepareArtifact, signedClaim } from "../bounties/select-bounties.js";

async function listBounties() {
  const { items } = await listOpenBounties();
  return { status: "success", open: items.length, items: items.map((i) => ({ id: i.id, reward: i.reward, input: i.input.url })) };
}

async function claimBounty(agent: SolanaAgentKit, input: { item: number; project: string }) {
  const item = (await listOpenBounties()).items.find((i) => i.id.endsWith(`:${input.item}`));
  if (!item) return { status: "error", message: `item ${input.item} is not open` };
  const { artifact, sha256, matches } = await prepareArtifact(item);
  if (!matches) return { status: "error", message: `artifact hash ${sha256} does not match` };
  const claim = await signedClaim(item.id, input.project, (m) => agent.wallet.signMessage(m), agent.wallet.publicKey.toBase58());
  return { status: "success", bountyId: item.id, sha256, artifactBase64: artifact.toString("base64"), claim,
    submit: `open an issue "Bounty claim ${item.id}" at https://github.com/SiiahK/rufus-agent-adapters/issues with the claim JSON and the artifact` };
}

const actions: Action[] = [
  { name: "SELECT_LIST_BOUNTIES", similes: ["list paid microtasks"], description: "[read-only] Open Select bounties (2 USDC each, Solana mainnet).",
    examples: [], schema: z.object({}), handler: async () => listBounties() },
  { name: "SELECT_CLAIM_BOUNTY", similes: ["do a Select bounty"], description: "Build the artifact for a Select bounty item and sign the claim with the agent wallet (message only, no spend).",
    examples: [], schema: z.object({ item: z.number().int().min(1).max(99), project: z.string().regex(/^[a-z0-9-]{3,64}$/) }),
    handler: async (agent: SolanaAgentKit, input: Record<string, any>) => claimBounty(agent, input as { item: number; project: string }) },
];

export const selectBountiesPlugin: Plugin = {
  name: "select-bounties",
  methods: { select_list_bounties: listBounties, select_claim_bounty: claimBounty },
  actions,
  initialize(_agent: SolanaAgentKit) { /* nothing to set up */ },
};
