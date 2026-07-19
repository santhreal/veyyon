import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { exponentialBackoffDelay } from "../src/backoff";

describe("exponentialBackoffDelay", () => {
	it("doubles the base delay per attempt until the cap (jitter pinned to the midpoint)", () => {
		// random = 0.5 -> factor 1 - 0.25 + 0.5 * 0.5 = 1.0, so the delay is the
		// exact capped value and the exponential schedule is visible.
		const mid = { random: () => 0.5 };
		expect(exponentialBackoffDelay(0, mid)).toBe(1_000);
		expect(exponentialBackoffDelay(1, mid)).toBe(2_000);
		expect(exponentialBackoffDelay(2, mid)).toBe(4_000);
		expect(exponentialBackoffDelay(3, mid)).toBe(8_000);
		expect(exponentialBackoffDelay(4, mid)).toBe(16_000);
	});

	it("caps the pre-jitter delay at maxMs (default 30000)", () => {
		const mid = { random: () => 0.5 };
		// 2 ** 5 * 1000 = 32000 > 30000, so it clamps and stays clamped.
		expect(exponentialBackoffDelay(5, mid)).toBe(30_000);
		expect(exponentialBackoffDelay(6, mid)).toBe(30_000);
		expect(exponentialBackoffDelay(50, mid)).toBe(30_000);
	});

	it("reproduces the former relay schedule at the jitter extremes", () => {
		// The two relay clients used `capped * (0.75 + Math.random() * 0.5)`.
		// random = 0 -> capped * 0.75 (low edge); random -> 1 -> capped * 1.25.
		expect(exponentialBackoffDelay(0, { random: () => 0 })).toBe(750);
		expect(exponentialBackoffDelay(0, { random: () => 1 })).toBe(1_250);
		expect(exponentialBackoffDelay(2, { random: () => 0 })).toBe(3_000);
		expect(exponentialBackoffDelay(2, { random: () => 1 })).toBe(5_000);
	});

	it("keeps a real Math.random draw within the jitter band for every attempt", () => {
		for (let attempt = 0; attempt < 12; attempt++) {
			const capped = Math.min(1_000 * 2 ** attempt, 30_000);
			for (let i = 0; i < 200; i++) {
				const delay = exponentialBackoffDelay(attempt);
				expect(delay).toBeGreaterThanOrEqual(capped * 0.75);
				expect(delay).toBeLessThan(capped * 1.25);
			}
		}
	});

	it("honors custom base, max, and jitter", () => {
		const mid = { random: () => 0.5 };
		expect(exponentialBackoffDelay(0, { baseMs: 500, ...mid })).toBe(500);
		expect(exponentialBackoffDelay(10, { baseMs: 500, maxMs: 5_000, ...mid })).toBe(5_000);
		// jitter 0 removes all spread: the delay is exactly the capped value.
		expect(exponentialBackoffDelay(1, { jitter: 0, random: () => 0 })).toBe(2_000);
		// jitter 0.5 with random 0 -> capped * 0.5.
		expect(exponentialBackoffDelay(1, { jitter: 0.5, random: () => 0 })).toBe(1_000);
	});
});

// Repo-wide source lock: the reconnect backoff schedule has exactly ONE owner,
// packages/utils/src/backoff.ts. The two former copies (collab-web
// src/lib/socket.ts, coding-agent src/collab/relay-client.ts) re-point here, so
// the grandfathered set is empty: any new local BACKOFF_BASE_MS / BACKOFF_MAX_MS
// const, or a hand-rolled `... * (0.75 + Math.random() * 0.5)` jitter, fails the
// lock and must call exponentialBackoffDelay instead.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");

const LOCAL_BACKOFF_CONST = /const\s+BACKOFF_(?:BASE|MAX)_MS\s*=/;
const HANDROLLED_JITTER = /0\.75\s*\+\s*Math\.random\(\)\s*\*\s*0\.5/;

async function walk(dir: string, out: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
}

describe("reconnect backoff source lock", () => {
	it("no production source hand-rolls the backoff schedule outside utils/src/backoff.ts", async () => {
		const constOffenders: string[] = [];
		const jitterOffenders: string[] = [];
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			const files: string[] = [];
			try {
				await walk(path.join(PACKAGES_DIR, pkg.name, "src"), files);
			} catch {
				// Package without a src/ directory (assets-only) — nothing to scan.
			}
			for (const file of files) {
				const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
				if (rel === "utils/src/backoff.ts") continue;
				const text = await readFile(file, "utf8");
				if (LOCAL_BACKOFF_CONST.test(text)) constOffenders.push(rel);
				if (HANDROLLED_JITTER.test(text)) jitterOffenders.push(rel);
			}
		}
		expect(
			constOffenders,
			"local BACKOFF_BASE_MS/BACKOFF_MAX_MS copies: import exponentialBackoffDelay from @veyyon/utils instead",
		).toEqual([]);
		expect(
			jitterOffenders,
			"hand-rolled backoff jitter: call exponentialBackoffDelay from @veyyon/utils instead",
		).toEqual([]);
	});
});
