# @selecto-infra/agent-adapters

TypeScript SDK and agent-framework connectors for **Select v2 Escrow** by Select Infrastructure — program-controlled USDC escrow on Solana for verifiable tasks between AI agents. Maintained by the Select Team.

> The package name is `@selecto-infra/agent-adapters` (until 0.3.0 it was `@rufus/agent-adapters`). It is distributed from GitHub; it is not on the npm registry yet. Technical identifiers keep the `rufus` namespace for compatibility: exports such as `RufusEscrowClient`, tool names `rufus.*`, actions `RUFUS_*` and the signing domain `rufus-v2-escrow`. They are not renamed.

- Program (mainnet-beta): [`E3XAx7qEKHte9kmWKhuyAVxb8CgE2g4k5FqkrRx2kdsF`](https://solscan.io/account/E3XAx7qEKHte9kmWKhuyAVxb8CgE2g4k5FqkrRx2kdsF)
- Developer docs and API: <https://api.tryaigility.com/developers> · [OpenAPI](https://api.tryaigility.com/openapi.json) · [llms.txt](https://api.tryaigility.com/llms.txt)
- License: MIT

> **Status: pilot.** The program is live on mainnet with a Squads 2-of-3 multisig as upgrade/admin authority and a Turnkey-held executor. The settlement worker currently refunds any task above **10 USDC** gross (off-chain pilot limit; check `GET /health`). There has been **no external security audit**. Install from GitHub (below); not on the npm registry yet.

## How the escrow works

1. The **payer** funds a task: USDC amount, worker (callee), deadline, and a release condition — either the payer's own signed approval, or the SHA-256 of an artifact committed in advance.
2. A **2% fee** (200 bps) is taken at creation, inside the amount (`floor(gross × 200 / 10 000)`); 25% of that fee goes to an eligible integrator when its DirectWallet commission account is passed, otherwise to the treasury. The worker receives the rest. **The fee is not refunded.**
3. The registered **executor** releases to the worker when the evidence checks pass, or refunds the net principal. After the deadline the payer can refund directly.
4. Closing a finished task returns the rent deposit (~0.00287 SOL) to the payer; a 105-byte tombstone (~0.00118 SOL) stays to prevent replay.

Pyth price data is only a depeg guard at settlement — it does not verify work. A hash commitment proves content identity, not quality.

## What this SDK gives an agent

| Operation | Kind | Notes |
|---|---|---|
| `previewTask` | read-only | every cost (fee, net, rent, network fees), task address, refund and evidence rules; versioned, expires in 5 min, bound by a SHA-256 digest |
| `createTask` | financial | requires the signer, the spend policy and a `SpendAuthorization` bound to that exact preview; simulates first; persists the signature before sending; the same idempotency key always maps to the same task address |
| `getTask` | read-only | on-chain state and local reconciliation state, reported separately |
| `submitEvidence` | financial | payer release approval, or artifact bytes (sent only if they match the commitment) |
| `requestRefund` | financial | signed request before the deadline; payer-direct `refund_task_v2` after it |
| `getReceipt` | read-only | final only when backed by a finalized settle/refund signature |

Amounts are decimal strings at the API and `bigint` internally — never floats.

### Spend control

- **Policy** (`loadPolicy`): allowed mints, per-task cap, cumulative budget, callee allowlist, allowed tools, deadline window. Frozen at construction; prompts, tool inputs and task descriptions cannot change it.
- **Authorization** (`signAuthorization` / `verifyAuthorization`): ed25519 signature by a principal registered for the tenant and wallet, binding program ID, cluster, action, budget, preview digest or task, a single-use nonce and an expiry. Wrong tenant, wallet, cluster, mint, amount, preview or a replayed nonce is rejected before anything is signed.
- **Signer** stays behind `TaskSigner` (wallet adapter, HSM, Turnkey…); keys never enter the LLM context.

## Quick start

```bash
# prebuilt release tarball (no build step)
npm install https://github.com/SiiahK/rufus-agent-adapters/releases/download/v0.4.3/selecto-infra-agent-adapters-0.4.3.tgz
# or from the tag (builds dist/ on install through the `prepare` script)
npm install github:SiiahK/rufus-agent-adapters#v0.4.3
# or from source:
git clone https://github.com/SiiahK/rufus-agent-adapters.git
cd rufus-agent-adapters && npm ci && npm test && npm run build   # build emits dist/ for the package exports
```

The core has no agent-framework dependency. Install a framework only if you use its connector (see Connectors).

```ts
import { Connection, Keypair } from "@solana/web3.js";
import {
  RufusEscrowClient, connectionReader, connectionSender, keypairSigner, loadPolicy,
  memoryBudgetTracker, memoryNonceStore, signAuthorization, USDC_MINT, PROGRAM_ID,
} from "@selecto-infra/agent-adapters/core";

const conn = new Connection(process.env.RPC_URL!, "confirmed");
const client = new RufusEscrowClient({
  cluster: "mainnet-beta",
  chain: connectionReader(conn), sender: connectionSender(conn), signer: keypairSigner(payer),
  evidenceBaseUrl: "https://api.tryaigility.com",
  policy: loadPolicy({
    version: 1, policyId: "my-agent", cluster: "mainnet-beta",
    mints: { [USDC_MINT.toBase58()]: { maxGrossPerTaskRaw: "2000000", budgetRaw: "10000000" } },
    allowedCallees: [worker], allowedTools: ["rufus.preview_task", "rufus.create_task", "rufus.get_receipt"],
    minDeadlineSecs: 300, maxDeadlineSecs: 86_400,
  }),
  registry: { principalsFor: (tenant) => [{ principal: approver.publicKey.toBase58(), wallets: [payer.publicKey.toBase58()] }] },
  nonces: memoryNonceStore(),      // use a durable store in production
  budget: memoryBudgetTracker(),   // idem
});

const preview = await client.previewTask({
  cluster: "mainnet-beta", tenant: "acme", payer: payer.publicKey.toBase58(), callee: worker,
  mint: USDC_MINT.toBase58(), amount: "1", amountBasis: "gross", deadlineSecs: 3600,
  verification: { type: "payer_approval" }, idempotencyKey: "order-42",
});
// show preview.display / preview.rent / preview.rules to the approver, then:
const now = Math.floor(Date.now() / 1000);
const authorization = signAuthorization({
  v: 1, domain: "rufus-v2-escrow", programId: PROGRAM_ID.toBase58(), cluster: "mainnet-beta", tenant: "acme",
  principal: approver.publicKey.toBase58(), wallet: payer.publicKey.toBase58(), action: "create_task",
  budget: { mint: USDC_MINT.toBase58(), maxGrossRaw: preview.binding.grossRaw }, previewDigest: preview.digest,
  nonce: crypto.randomUUID().replace(/-/g, ""), issuedAt: now, expiresAt: now + 300,
}, approver.secretKey);
const { task, state } = await client.createTask(preview, authorization);
```

## Connectors

Each connector is a separate entry point, and its framework is an optional peer dependency, so you install only the one you use:

```bash
npm install solana-agent-kit@2.0.10                          # for ./solana-agent-kit
npm install @elizaos/core@1.7.2                              # for ./elizaos
npm install @lucid-agents/core@5.0.0 @lucid-agents/a2a@2.0.0 # for ./lucid
```

All connectors share the same tools (`rufus.preview_task`, `rufus.create_task`, `rufus.get_task`, `rufus.get_receipt`, `rufus.request_refund`, `rufus.submit_evidence`) with strict schemas. Financial tools call your `authorize()` callback — a human or principal approval outside the agent; returning `null` means nothing is signed.

```ts
import { createRufusSakPlugin } from "@selecto-infra/agent-adapters/solana-agent-kit";
import { createRufusElizaPlugin } from "@selecto-infra/agent-adapters/elizaos";
import { createRufusLucidAgent } from "@selecto-infra/agent-adapters/lucid";
const cfg = { client, tenant: "acme", cluster: "mainnet-beta", wallet: payer.publicKey.toBase58(), authorize: async (req) => askApprover(req) };

agent.use(createRufusSakPlugin(cfg));                                              // Solana Agent Kit 2.0.10
runtime.registerPlugin(createRufusElizaPlugin({ ...cfg, operatorEntityIds: [me] })); // ElizaOS 1.7.2 (input in content.rufus)
const { runtime: lucid } = await createRufusLucidAgent({ ...cfg, calleeWallet, perform }); // Lucid Agents 5.0.0 + a2a 2.0.0
```

| Framework | Pinned version | Tested |
|---|---|---|
| SendAI Solana Agent Kit | 2.0.10 | plugin loaded with `SolanaAgentKit.use`, actions executed with `executeAction` |
| ElizaOS | @elizaos/core 1.7.2 | plugin registered in a real `AgentRuntime`, actions validated and executed |
| Lucid Agents | core 5.0.0 + a2a 2.0.0 | runtime built, manifest generated, entrypoints executed (worker delivery as an A2A task) |

Details, planned targets and the x402 position: [docs/integration-matrix.md](docs/integration-matrix.md). Select is a custom escrow integration, not an x402 scheme.

## Unified helpers

```ts
// client: your signer, spend policy and authorize() (host approval, never the LLM)
const job = await client.createTaskEscrow({ amount: "1.5", taskId: "job-42", providerPubkey: PROVIDER, timeoutSeconds: 3600, authorize });
await client.releaseTaskEscrow({ taskId: "job-42", providerPubkey: PROVIDER, authorize });   // payer approval → executor settles
await client.refundTaskEscrow({ taskId: "job-42", authorize });                             // signed request, or payer-direct after the deadline
```

The same `taskId` always maps to the same task address, so a retry cannot charge a second fee.

## Routing domain (0.3.0)

New tasks use the routing domain **`payments_v2`** by default. It was created on mainnet on 2026-10-01 by the Squads multisig, with a 24 h volume cap of 35 000 USDC; the older `m2m` domain has 100 USDC. Override with `new RufusEscrowClient({ …, domain: "m2m" })` or `RUFUS_ROUTING_DOMAIN`. The domain is bound into the preview digest that the host authorizes, and a preview for a domain that does not exist on the cluster is blocked. Settlement reads the domain stored in each task, so older `m2m` tasks keep working.

## Integrator commission (affiliate)

The program pays 25% of the 2% fee (50 of 200 bps) to a third party **only** when the creation carries a registered **DirectWallet** `IntegratorConfig` and a token account of its commission wallet. Set the integrator authority in the host:

- `new RufusEscrowClient({ …, affiliate: "<integrator authority>" })`, or
- environment `SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY` (checked first) or `RUFUS_AFFILIATE_PUBKEY`.

Before each creation the SDK checks on-chain that the integrator is registered, active and DirectWallet, that its commission token account exists, and that it is not the payer. If any check fails, the whole fee goes to the treasury. There is **no fallback to the payer's key** (that would be self-referral). Agent tools cannot set or change the affiliate.

## escrow-402 (custom HTTP 402 handshake — not x402)

A provider answers `402` with `X-Escrow-Scheme: solana-rufus-v2`, `X-Escrow-Program`, `X-Escrow-Amount` (atomic units), `X-Escrow-Mint`, `X-Escrow-Payee` and `X-Escrow-Timeout`. The client funds an escrow task and retries with `X-Escrow-Task` / `X-Escrow-Tx`. Standard x402 clients do not understand this handshake, and it does not claim x402 conformance.

```ts
import { escrowFetch, expressEscrow } from "@selecto-infra/agent-adapters";
app.post("/job", expressEscrow({ chain, terms: { amountRaw: 1_500_000n, mint: USDC, payee: ME, timeoutSecs: 3600 } }), handler); // also honoEscrow
const { response, escrow } = await escrowFetch(url, { method: "POST", body }, { client, authorize });
```

- `escrowFetch` pays only within the spend policy (allowed payees, per-task and cumulative caps) and with the host's authorization. The same challenge reuses its task, and a server-suggested affiliate is ignored unless `acceptServerAffiliate: true`.
- The provider middleware checks the task on-chain: right payee, mint and amount, funded, enough time before the deadline. Each task unlocks **one** request.
- Payment is released later on the payer's approval, or refunded.

## MCP server (`mcp-server-escrow/`)

A stdio MCP server with the tools `create_escrow_task`, `get_task_status`, `verify_collateral_websocket`, `release_escrow_task`, `refund_timeout_task` and `register_integrator`. **It holds no private key.** It returns unsigned transactions, or the exact message the payer must sign. The integrator comes from the server's environment only.

```bash
cd mcp-server-escrow && npm install --ignore-scripts
RUFUS_RPC_URL=<rpc> RUFUS_AFFILIATE_PUBKEY=<integrator> MCP_ESCROW_MAX_GROSS_RAW=10000000 npx tsx src/index.ts
```

## Integrators: earn 0.5% of the volume you bring

Agent platforms, frameworks and marketplaces whose users create escrow tasks can earn 25% of the fee (50 bps of gross), paid in USDC atomically inside `create_task_v2`.

```ts
import { integratorOnboarding } from "@selecto-infra/agent-adapters/core";
const o = await integratorOnboarding(chain, myAuthority);        // optional: commission wallet, mint
// o.status: "ready" | "needs_setup" | "blocked"; sign o.instructions with myAuthority (rent ≈ 0.0027 SOL)
```

The MCP tool `register_integrator` returns the same as an unsigned transaction. Then ship your SDK or MCP build with `SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY=<myAuthority>`. A payer never earns on its own tasks.

## Changes in 0.4.3

- **Package renamed to `@selecto-infra/agent-adapters`.** The code is identical to 0.4.2. Update your imports, for example `@selecto-infra/agent-adapters/solana-agent-kit`.
- Distributed as a GitHub Release asset: `npm install https://github.com/SiiahK/rufus-agent-adapters/releases/download/v0.4.3/selecto-infra-agent-adapters-0.4.3.tgz`. It is not on the npm registry.

## Changes in 0.4.2

- `connectionReader().now()` reads cluster time from the Clock sysvar, the clock the program uses for deadlines. `getBlockTime(latest slot)` is now only a fallback: some RPCs have not stored the newest block yet, and previews and creations failed with "Block not available for slot".
- No change to the on-chain program, fees, tools or signing domain.

## Changes in 0.4.1

- `integratorOnboarding()` and `buildCreateAtaIdempotentIx()`: register a DirectWallet integrator and its commission token account.
- MCP: new tools `register_integrator` (unsigned onboarding transaction) and `get_task_status` (live task or tombstone, plus the `rufus://<task>` receipt).
- No change to the on-chain program, fees or signing domain.

## Changes in 0.4.0

- Distributed from GitHub (`npm install github:SiiahK/rufus-agent-adapters#v0.4.2`, or the release tarball); `prepare` builds `dist/` on install.
- Package name `@selecto-infra/agent-adapters` (was `@rufus/agent-adapters`).
- **Breaking:** the root entry exports only the framework-free core. Import connectors from `/solana-agent-kit`, `/elizaos` or `/lucid`.
- Solana Agent Kit, ElizaOS and Lucid Agents are optional peer dependencies (tested at the pinned versions above).
- No change to the on-chain program, fees, tools or signing domain.

## Tests

`npm test` runs, without network or LLM calls, affiliate routing and escrow-402 parsing as well as: fee math and rounding thresholds, amount parsing, preview digest and tampering, authorization binding and replay, spend policy, and the three connectors inside their real runtimes. Fee values match the deployed program; the end-to-end suite that replays the approved binary over mainnet state (concurrency, crash recovery, refunds, receipts, webhooks) lives in the main Select repository.

## License

MIT — see [LICENSE](LICENSE).
