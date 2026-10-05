/**
 * Select bounties for agents: list the open microtasks, produce the exact artifact, check it against the
 * published hash, and build the signed claim. Framework-free (Node ≥ 20 + tweetnacl + bs58); the ElizaOS and
 * Solana Agent Kit examples reuse it.
 *
 *   npx tsx examples/bounties/select-bounties.ts                 list open items
 *   npx tsx examples/bounties/select-bounties.ts 7               prepare item 7 → out.json (+ hash check)
 *   npx tsx examples/bounties/select-bounties.ts 7 --wallet ~/.config/solana/id.json --project my-agent
 *                                                                 … and print the signed claim to submit
 *
 * Sponsored by Select: 2 USDC per item on Solana mainnet, max 3 paid items per project, reviewed within 24 h.
 * Terms and the full guide: https://api.tryaigility.com/bounties (machine-readable: GET /v2/bounties → guide).
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";

export const API = process.env.SELECT_API ?? "https://api.tryaigility.com";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface BountyItem { id: string; reward: string; status: string; input: { url: string; sha256: string }; expectedOutputSha256: string }

export async function listOpenBounties(api = API): Promise<{ campaign: any; items: BountyItem[]; guide: any }> {
  const r = await fetch(`${api}/v2/bounties`);
  if (!r.ok) throw new Error(`GET /v2/bounties: HTTP ${r.status}`);
  const b: any = await r.json();
  return { campaign: b.campaign, items: (b.items as BountyItem[]).filter((i) => i.status === "open" && i.input), guide: b.guide };
}

/** Reference transform (byte-exact): rows → objects with sorted keys, trimmed string values, compact JSON. */
export function csvToJson(text: string): string {
  const parse = (line: string) => {
    const out: string[] = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur); return out;
  };
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
  const header = parse(lines[0]!).map((h) => h.trim());
  return JSON.stringify(lines.slice(1).map((l) => { const c = parse(l); return Object.fromEntries([...header].sort().map((k) => [k, c[header.indexOf(k)]!.trim()])); }));
}

/** Downloads the input, checks its hash, transforms it and checks the output against the expected hash. */
export async function prepareArtifact(item: BountyItem): Promise<{ artifact: Buffer; sha256: string; matches: boolean }> {
  const input = new Uint8Array(await (await fetch(item.input.url)).arrayBuffer());
  if (sha256(input) !== item.input.sha256) throw new Error(`input hash mismatch for ${item.id}`);
  const artifact = Buffer.from(csvToJson(Buffer.from(input).toString("utf-8")), "utf-8");
  const h = sha256(artifact);
  return { artifact, sha256: h, matches: h === item.expectedOutputSha256 };
}

/** The exact message the payout wallet signs (≤ 24 h validity, single-use nonce). */
export function claimMessage(bountyId: string, projectId: string, expiresInSecs = 12 * 3600) {
  if (!/^[a-z0-9-]{3,64}$/.test(projectId)) throw new Error("projectId must match ^[a-z0-9-]{3,64}$");
  const nonce = randomBytes(16).toString("hex"), expiresAt = Math.floor(Date.now() / 1000) + Math.min(expiresInSecs, 23 * 3600);
  return { bountyId, projectId, nonce, expiresAt, message: `rufus-bounty-claim:v1:rufus-bounties-2026q4:${bountyId}:${projectId}:${nonce}:${expiresAt}` };
}

/** Claim JSON to attach to an issue titled "Bounty claim <bountyId>" at github.com/SiiahK/rufus-agent-adapters/issues. */
export async function signedClaim(bountyId: string, projectId: string, sign: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array, walletBase58: string) {
  const c = claimMessage(bountyId, projectId);
  const signature = bs58.encode(await sign(new TextEncoder().encode(c.message)));
  return { bountyId, project: projectId, wallet: walletBase58, nonce: c.nonce, expiresAt: c.expiresAt, signature };
}

async function main() {
  const [arg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const opt = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const { items } = await listOpenBounties();
  if (!arg) { for (const i of items) console.log(`${i.id}  ${i.reward} USDC  ${i.input.url}`); console.log(`${items.length} open`); return; }
  const item = items.find((i) => i.id.endsWith(`:${arg}`));
  if (!item) throw new Error(`item ${arg} is not open`);
  const { artifact, sha256: h, matches } = await prepareArtifact(item);
  writeFileSync("out.json", artifact);
  console.log(`out.json written (${artifact.length} bytes), sha256 ${h}, ${matches ? "MATCHES the expected hash" : "does NOT match"}`);
  const walletFile = opt("--wallet");
  if (walletFile && matches) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(walletFile.replace(/^~/, process.env.HOME ?? "~"), "utf-8")));
    const kp = nacl.sign.keyPair.fromSecretKey(secret);
    const claim = await signedClaim(item.id, opt("--project") ?? "my-agent", (m) => nacl.sign.detached(m, kp.secretKey), bs58.encode(kp.publicKey));
    console.log("\nOpen an issue titled \"Bounty claim " + item.id + "\" at https://github.com/SiiahK/rufus-agent-adapters/issues with out.json and:\n" + JSON.stringify(claim, null, 2));
  }
}

if (process.argv[1]?.endsWith("select-bounties.ts")) main().catch((e) => { console.error(e.message); process.exit(1); });
