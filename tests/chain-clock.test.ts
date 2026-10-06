/** connectionReader().now(): Clock sysvar first; getBlockTime and local time only as fallbacks. */
import { describe, it, expect } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";
import { connectionReader } from "../src/index.js";

const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const clockData = (unix: number) => { const b = Buffer.alloc(40); b.writeBigInt64LE(BigInt(unix), 32); return b; };

describe("connectionReader clock", () => {
  it("reads unix_timestamp from the Clock sysvar without calling getBlockTime", async () => {
    let calls = 0;
    const conn = { getAccountInfo: async (k: PublicKey) => (k.toBase58() === CLOCK ? { data: clockData(1_791_247_440) } : null),
      getSlot: async () => 1, getBlockTime: async () => { calls++; throw new Error("Block not available for slot 1"); } } as unknown as Connection;
    expect(await connectionReader(conn).now()).toBe(1_791_247_440);
    expect(calls).toBe(0);
  });

  it("falls back to getBlockTime, then to local time", async () => {
    const base = { getAccountInfo: async () => null, getSlot: async () => 7 };
    expect(await connectionReader({ ...base, getBlockTime: async () => 1_700_000_000 } as unknown as Connection).now()).toBe(1_700_000_000);
    const t = await connectionReader({ ...base, getBlockTime: async () => { throw new Error("Block not available"); } } as unknown as Connection).now();
    expect(Math.abs(t - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
  });
});
