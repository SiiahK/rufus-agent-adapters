// Root entry = framework-free core. Framework connectors load only from their subpaths, so installing the
// package does not pull Solana Agent Kit, ElizaOS or Lucid (optional peer dependencies):
//   import { createRufusSakPlugin } from "@selecto-infra/agent-adapters/solana-agent-kit";
//   import { createRufusElizaPlugin } from "@selecto-infra/agent-adapters/elizaos";
//   import { createRufusLucidAgent } from "@selecto-infra/agent-adapters/lucid";
export * from "./core.js";
