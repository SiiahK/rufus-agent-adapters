#!/usr/bin/env node
/**
 * @rufus/mcp-server-escrow — MCP (stdio) server for Select v2 Escrow.
 *
 *   RUFUS_RPC_URL=<rpc> [RUFUS_CLUSTER=mainnet-beta] [RUFUS_EVIDENCE_URL=https://api.tryaigility.com]
 *   [MCP_ESCROW_MAX_GROSS_RAW=2050000] [SOLANA_AGENT_ESCROW_AFFILIATE_PUBKEY=<integrator>] npx tsx src/index.ts
 *
 * Tools: create_escrow_task, verify_collateral_websocket, release_escrow_task, refund_timeout_task.
 * No private key is loaded; financial tools return unsigned transactions or the message to sign.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { web3, affiliateFromEnv, connectionReader } from "../../src/core.js";
import { createEscrowTask, refundTimeoutTask, releaseEscrowTask, verifyCollateral, ToolError, type EscrowToolDeps } from "./tools.js";

const KEY = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export function buildServer(d: EscrowToolDeps) {
  const server = new McpServer({ name: "rufus-mcp-server-escrow", version: "0.1.0" });
  const wrap = (fn: (i: any) => Promise<unknown>) => async (i: any) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await fn(i), null, 2) }] }; }
    catch (e: any) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof ToolError ? e.code : "error", message: String(e?.message ?? e).slice(0, 300) }) }] }; }
  };
  server.registerTool("create_escrow_task", {
    description: "Build an UNSIGNED Select v2 Escrow create transaction (USDC, payer approval release). Fee 2% inside the amount; 25% of it to the server's configured DirectWallet integrator when valid, else treasury. Returns the transaction for the payer wallet to sign; nothing is signed or sent.",
    inputSchema: { payer: KEY, providerPubkey: KEY, amountRaw: z.string().regex(/^[1-9][0-9]{0,19}$/), taskId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), timeoutSeconds: z.number().int().min(60).max(2_592_000) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, wrap((i) => createEscrowTask(d, i)));
  server.registerTool("verify_collateral_websocket", {
    description: "Wait (websocket account subscription) until an escrow task is funded or terminal, up to 120 s. Read-only.",
    inputSchema: { task: KEY, until: z.enum(["funded", "terminal"]).optional(), timeoutSeconds: z.number().int().min(1).max(120).optional(), payee: KEY.optional(), minGrossRaw: z.string().regex(/^[0-9]{1,20}$/).optional() },
    annotations: { readOnlyHint: true },
  }, wrap((i) => verifyCollateral(d, i)));
  server.registerTool("release_escrow_task", {
    description: "Return the exact release message the task PAYER must sign and the endpoint to post it to. The executor settles after verifying it. This server cannot sign or release funds.",
    inputSchema: { task: KEY }, annotations: { readOnlyHint: true },
  }, wrap((i) => releaseEscrowTask(d, i)));
  server.registerTool("refund_timeout_task", {
    description: "After the deadline: build an UNSIGNED payer-direct refund transaction (net escrow back to the payer; the fee is not refunded).",
    inputSchema: { task: KEY }, annotations: { readOnlyHint: true },
  }, wrap((i) => refundTimeoutTask(d, i)));
  return server;
}

async function main() {
  const rpc = process.env.RUFUS_RPC_URL;
  if (!rpc) throw new Error("RUFUS_RPC_URL is required");
  const conn = new web3.Connection(rpc, "confirmed");
  const max = process.env.MCP_ESCROW_MAX_GROSS_RAW ?? "2050000";
  if (!/^[1-9][0-9]{0,19}$/.test(max)) throw new Error("MCP_ESCROW_MAX_GROSS_RAW must be a positive integer");
  const d: EscrowToolDeps = {
    chain: connectionReader(conn), cluster: (process.env.RUFUS_CLUSTER as EscrowToolDeps["cluster"]) ?? "mainnet-beta",
    latestBlockhash: () => conn.getLatestBlockhash("confirmed"), affiliate: affiliateFromEnv(process.env), maxGrossRaw: BigInt(max),
    evidenceBaseUrl: process.env.RUFUS_EVIDENCE_URL ?? "https://api.tryaigility.com",
    subscribe: async (account, onChange) => { const id = conn.onAccountChange(account, onChange, { commitment: "confirmed" }); return () => conn.removeAccountChangeListener(id); },
  };
  await buildServer(d).connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`[mcp-server-escrow] ${e.message}`); process.exit(1); });
