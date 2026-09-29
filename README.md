# @rufus/agent-adapters

TypeScript SDK and agent-framework connectors for **Rufus v2 Escrow** — program-controlled USDC escrow on Solana for verifiable tasks between AI agents.

- Program (mainnet-beta): [`E3XAx7qEKHte9kmWKhuyAVxb8CgE2g4k5FqkrRx2kdsF`](https://solscan.io/account/E3XAx7qEKHte9kmWKhuyAVxb8CgE2g4k5FqkrRx2kdsF)
- Developer docs and API: <https://api.tryaigility.com/developers> · [OpenAPI](https://api.tryaigility.com/openapi.json) · [llms.txt](https://api.tryaigility.com/llms.txt)
- License: MIT

> **Status: pilot.** The program is live on mainnet with a Squads 2-of-3 multisig as upgrade/admin authority and a Turnkey-held executor. The settlement worker currently refunds any task above **2.05 USDC** gross (off-chain pilot limit; check `GET /health`). There has been **no external security audit**. This package is not published to npm yet; install from source.

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
git clone https://github.com/SiiahK/rufus-agent-adapters.git
cd rufus-agent-adapters && npm ci && npm test && npm run build   # build emits dist/ for the package exports
```

```ts
import { Connection, Keypair } from "@solana/web3.js";
import {
  RufusEscrowClient, connectionReader, connectionSender, keypairSigner, loadPolicy,
  memoryBudgetTracker, memoryNonceStore, signAuthorization, USDC_MINT, PROGRAM_ID,
} from "@rufus/agent-adapters/core";

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

All connectors share the same tools (`rufus.preview_task`, `rufus.create_task`, `rufus.get_task`, `rufus.get_receipt`, `rufus.request_refund`, `rufus.submit_evidence`) with strict schemas. Financial tools call your `authorize()` callback — a human or principal approval outside the agent; returning `null` means nothing is signed.

```ts
import { createRufusSakPlugin, createRufusElizaPlugin, createRufusLucidAgent } from "@rufus/agent-adapters";
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

Details, planned targets and the x402 position: [docs/integration-matrix.md](docs/integration-matrix.md). Rufus is a custom escrow integration, not an x402 scheme.

## Tests

`npm test` runs, without network or LLM calls: fee math and rounding thresholds, amount parsing, preview digest and tampering, authorization binding and replay, spend policy, and the three connectors inside their real runtimes. Fee values match the deployed program; the end-to-end suite that replays the approved binary over mainnet state (concurrency, crash recovery, refunds, receipts, webhooks) lives in the main Rufus repository.

## License

MIT — see [LICENSE](LICENSE).
