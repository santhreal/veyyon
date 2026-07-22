import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MCPToolCache } from "@veyyon/coding-agent/mcp/tool-cache";
import type { MCPServerConfig, MCPToolDefinition } from "@veyyon/coding-agent/mcp/types";
import type { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { DAY_MS } from "@veyyon/utils";

/**
 * MCPToolCache keys cached tool lists by a stable hash of the server config so a
 * cosmetic reordering of config keys does not needlessly invalidate the cache,
 * while a real config change does. It had no test. These use an in-memory storage
 * stub to pin the hit/miss contract: key-order independence, config-change miss,
 * version gate, corrupt-entry safety, and the 30-day TTL written to storage.
 */

class FakeStorage {
	readonly entries = new Map<string, string>();
	lastKey: string | undefined;
	lastExpiresAtSec: number | undefined;

	getCache(key: string): string | null {
		return this.entries.get(key) ?? null;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.entries.set(key, value);
		this.lastKey = key;
		this.lastExpiresAtSec = expiresAtSec;
	}
}

const TOOLS: MCPToolDefinition[] = [{ name: "search", inputSchema: { type: "object", properties: { q: {} } } }];

let storage: FakeStorage;
let cache: MCPToolCache;

beforeEach(() => {
	storage = new FakeStorage();
	cache = new MCPToolCache(storage as unknown as AgentStorage);
});
afterEach(() => {
	storage.entries.clear();
});

describe("MCPToolCache hit/miss", () => {
	it("returns the stored tools for the same config", async () => {
		const config: MCPServerConfig = { type: "http", url: "https://x", headers: { A: "1", B: "2" } };
		await cache.set("srv", config, TOOLS);
		expect(await cache.get("srv", config)).toEqual(TOOLS);
	});

	it("hits the cache when config keys are reordered (stable hash)", async () => {
		await cache.set("srv", { type: "http", url: "https://x", headers: { A: "1", B: "2" } }, TOOLS);
		// Same values, different insertion order at both levels.
		const reordered: MCPServerConfig = { headers: { B: "2", A: "1" }, url: "https://x", type: "http" };
		expect(await cache.get("srv", reordered)).toEqual(TOOLS);
	});

	it("misses when the config actually changes", async () => {
		await cache.set("srv", { type: "http", url: "https://x" }, TOOLS);
		expect(await cache.get("srv", { type: "http", url: "https://y" })).toBeNull();
	});

	it("returns null when there is no cached entry", async () => {
		expect(await cache.get("absent", { type: "http", url: "https://x" })).toBeNull();
	});
});

describe("MCPToolCache validation", () => {
	it("rejects a corrupt (non-JSON) cache entry without throwing", async () => {
		const config: MCPServerConfig = { type: "http", url: "https://x" };
		await cache.set("srv", config, TOOLS);
		storage.entries.set(storage.lastKey as string, "not json {");
		expect(await cache.get("srv", config)).toBeNull();
	});

	it("rejects an entry written under a different cache version", async () => {
		const config: MCPServerConfig = { type: "http", url: "https://x" };
		await cache.set("srv", config, TOOLS);
		storage.entries.set(
			storage.lastKey as string,
			JSON.stringify({ version: 999, configHash: "whatever", tools: [] }),
		);
		expect(await cache.get("srv", config)).toBeNull();
	});
});

describe("MCPToolCache TTL", () => {
	it("writes a 30-day expiry (in seconds) to storage", async () => {
		const before = Date.now();
		await cache.set("srv", { type: "http", url: "https://x" }, TOOLS);
		const after = Date.now();
		const low = Math.floor((before + 30 * DAY_MS) / 1000);
		const high = Math.floor((after + 30 * DAY_MS) / 1000);
		expect(storage.lastExpiresAtSec).toBeGreaterThanOrEqual(low);
		expect(storage.lastExpiresAtSec).toBeLessThanOrEqual(high);
	});
});
