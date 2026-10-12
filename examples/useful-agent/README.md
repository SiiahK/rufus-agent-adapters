# Service agent: 5 USDC technical dossier of a Solana repository

A worker agent that sells one deliverable, paid through Select Escrow on mainnet: a technical dossier of a public Solana repository at a pinned commit.

The dossier covers:
- the Anchor and solana-program versions;
- the declared program ids, and whether each one is upgradeable on mainnet and by whom;
- engineering hygiene (license, SECURITY.md, CI, tests, pinned toolchain, overflow checks);
- review pointers with file:line (unchecked accounts, `init_if_needed`, `remaining_accounts`, CPIs, `unwrap`, `unsafe`, narrowing casts).

**It is not a security audit.** It tells a reviewer where to look, and the file says so.

## Flow

| Step | Who | What |
|---|---|---|
| 1 | buyer | Funds a **payer-approval** task naming the worker: `PAYER_KEYPAIR=… npx tsx ../quickstart/fund.ts <worker wallet> 5 dossier-001` ([quickstart](../quickstart/README.md)). Sends the task address and the repository to the worker |
| 2 | worker | `npm run start:service-worker -- --task <task> --repo <owner/name>`. This checks the task on-chain and builds `out/<task>.md` from the repository's current commit. It then posts the worker's signed delivery report (the dossier's SHA-256) to `POST /v2/tasks/<task>/delivery` |
| 3 | worker → buyer | Sends `out/<task>.md` |
| 4 | buyer | `shasum -a 256 <file>` must equal `delivery.sha256` in `https://api.tryaigility.com/v2/tasks/<task>/settlement`. Then the buyer either **releases** (`decide.ts release <worker> dossier-001`) or **disputes** (`decide.ts refund …`) before `optimisticReleaseAt` |
| 5 | Select executor | Pays the worker 4.90 USDC (5 minus the 2% fee) on release. With no dispute, it pays automatically 30 minutes after the delivery report. The receipt appears at `https://api.tryaigility.com/v2/receipts/<task>` |

**Why not artifact-hash release?** A hash-release task needs the output's hash committed when the task is funded. Nobody knows a report's hash before it is written, so this agent uses payer approval plus the signed delivery report.

**Who holds what:**
- The worker never signs a payment; its only signature is the delivery report.
- The buyer's USDC sits in the program's escrow, not with Select.

## Run

```bash
cd examples/useful-agent && npm install
# preview: no task, no key; builds the dossier and prints its hash
RPC_URL=<mainnet RPC> npm run start:service-worker -- --repo coral-xyz/sealevel-attacks
# paid job (add --dry-run to check everything without posting the delivery report)
WORKER_KEYPAIR=<worker keypair> RPC_URL=<mainnet RPC> npm run start:service-worker -- --task <task> --repo <owner/name> [--ref <branch>]
```

### What the worker refuses

The worker exits before delivering when:
- the task pays someone else;
- the task is not funded;
- the task is not payer-approval;
- the task is not in USDC;
- the gross is below `PRICE_USDC` (default 5);
- fewer than 15 minutes are left before the deadline.

A re-run for the same task re-uses `out/<task>.md`, so the reported hash never changes.

### Limits

- public GitHub repositories only;
- the pilot cap is 10 USDC per task;
- no external audit of Select Escrow.
