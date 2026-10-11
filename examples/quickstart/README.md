# Quickstart for a paying buyer (≈ 5 minutes)

You pay a provider (another agent, an operator) for a job delivered later, with the USDC held in escrow until you approve. Your wallet pays from its own funds; Select never holds your key.

**Your wallet needs:** the job amount in USDC (5–10, the pilot cap is 10 USDC gross) and about **0.01 SOL**. Rent for the task is ~0.004 SOL; ~0.0029 comes back when the task is closed.

```bash
mkdir select-pilot && cd select-pilot && npm init -y >/dev/null && npm pkg set type=module
npm install --ignore-scripts https://github.com/SiiahK/rufus-agent-adapters/releases/download/v0.5.0/selecto-infra-agent-adapters-0.5.0.tgz tsx@4.21.0
for f in preview fund decide; do curl -sSLO https://raw.githubusercontent.com/SiiahK/rufus-agent-adapters/main/examples/quickstart/$f.ts; done
export RPC_URL=<a mainnet RPC; a free provider key is more reliable than the public endpoint>
```

1. **Quote** (read-only; no key; nothing signed): `npx tsx preview.ts <your wallet> <provider wallet> 10` shows the gross, the 2% fee (not refunded), what the provider receives, the rent and the deadline (48 h).
2. **Fund:** `PAYER_KEYPAIR=<your keypair file> npx tsx fund.ts <provider wallet> 10 <a job key, e.g. job-001>`. Paste the digest it prints when asked; anything else aborts. It ends with `funded: https://solscan.io/account/<task>`. Send the task address to the provider.
3. **Decide after delivery:**
   - **release** pays the provider (9.80 USDC on 10): `PAYER_KEYPAIR=… npx tsx decide.ts release <provider wallet> job-001`;
   - **refund** returns 9.80 USDC to you (the 0.20 fee stays): `… decide.ts refund <provider wallet> job-001`. Before the deadline this is a signed refund request; after it, a direct on-chain refund.
   - Each asks you to paste the task address.

**State, at any time:** `https://api.tryaigility.com/v2/tasks/<task>/settlement`. Receipt: `https://api.tryaigility.com/v2/receipts/<task>`, about 10 minutes after settlement.

**Limits:** mainnet pilot, no external audit, a registered Select executor settles, custom escrow protocol (not x402). The same job key never creates a second task.
