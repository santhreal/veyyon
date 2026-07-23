/**
 * Determinism source lock (TS-SUITE-5). A Rust port is only testable against
 * the conformance corpus if the TS oracle is deterministic: wall-clock and
 * RNG reads on an output path make TS and Rust disagree even when both are
 * correct. This scan fails if any hashline production source references
 * Date.now / Math.random / new Date outside the documented allowlist, so a
 * new nondeterminism source must either be seam-injected (a Clock/Rng passed
 * in) or explicitly justified here in the same change.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "../src");

/**
 * Files allowed to read the wall clock, each with the reason it cannot leak
 * into patch/tokenizer/normalize output. Remove an entry when the use is gone;
 * a stale entry fails the lock so the list only shrinks.
 */
const CLOCK_ALLOWLIST = new Map<string, string>([
	[
		"snapshots.ts",
		"Snapshot.recordedAt is LRU-recency metadata on the in-memory store; it is never read by apply/recovery and never serialized into patch output",
	],
]);

const NONDETERMINISM = /Date\.now|Math\.random|new Date\(/;

describe("hashline determinism lock", () => {
	it("no production source reads the clock or RNG outside the documented allowlist", () => {
		const offenders: string[] = [];
		const used = new Set<string>();
		for (const name of readdirSync(SRC_DIR)) {
			if (!name.endsWith(".ts")) continue;
			const text = readFileSync(join(SRC_DIR, name), "utf8");
			if (!NONDETERMINISM.test(text)) continue;
			if (CLOCK_ALLOWLIST.has(name)) {
				used.add(name);
				continue;
			}
			offenders.push(name);
		}
		expect(offenders, "new wall-clock/RNG read — inject a seam or document it in CLOCK_ALLOWLIST").toEqual([]);
		expect(
			[...CLOCK_ALLOWLIST.keys()].filter(name => !used.has(name)),
			"stale allowlist entries",
		).toEqual([]);
	});

	it("recordedAt stays write-only inside hashline (the allowlist's justification holds)", () => {
		// If any hashline source starts READING recordedAt, the metadata claim
		// above stops being true and the seam decision must be revisited.
		for (const name of readdirSync(SRC_DIR)) {
			if (!name.endsWith(".ts")) continue;
			const text = readFileSync(join(SRC_DIR, name), "utf8");
			for (const line of text.split("\n")) {
				if (!line.includes(".recordedAt")) continue;
				const isWrite = /\.recordedAt\s*=[^=]/.test(line);
				expect(isWrite, `read of recordedAt in ${name}: "${line.trim()}"`).toBe(true);
			}
		}
	});
});
