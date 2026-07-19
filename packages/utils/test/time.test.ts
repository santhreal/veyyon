import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, WEEK_MS } from "../src/time";

describe("time unit constants", () => {
	it("has the exact millisecond value for each unit", () => {
		expect(SECOND_MS).toBe(1000);
		expect(MINUTE_MS).toBe(60_000);
		expect(HOUR_MS).toBe(3_600_000);
		expect(DAY_MS).toBe(86_400_000);
		expect(WEEK_MS).toBe(604_800_000);
	});

	it("keeps each unit derived from the next smaller one", () => {
		expect(MINUTE_MS).toBe(60 * SECOND_MS);
		expect(HOUR_MS).toBe(60 * MINUTE_MS);
		expect(DAY_MS).toBe(24 * HOUR_MS);
		expect(WEEK_MS).toBe(7 * DAY_MS);
	});

	it("matches the two former same-value/different-name copies exactly", () => {
		// `SEVEN_DAYS_MS` (ai usage claude.ts, zai.ts) and `MS_PER_DAY`
		// (mnemopi temporal-parser.ts) were separate names for these values.
		// Both folded into WEEK_MS / DAY_MS, so pin the values they carried.
		expect(WEEK_MS).toBe(7 * 24 * 60 * 60 * 1000);
		expect(DAY_MS).toBe(86_400_000);
	});
});

// Repo-wide source lock: the millisecond duration constants have exactly ONE
// owner, packages/utils/src/time.ts. Every former local copy (ai usage
// claude.ts / zai.ts SEVEN_DAYS_MS, ai usage opencode-go.ts, coding-agent
// gc-cli.ts DAY_MS, stats aggregator.ts / client range-meta.ts HOUR_MS+DAY_MS,
// mnemopi temporal-parser.ts MS_PER_DAY) now imports from here, so the
// grandfathered set is empty: any new named `const <UNIT>_MS = ...` outside the
// owner fails the lock and must import instead. Inline full-composite literals
// (`24 * 60 * 60 * 1000` and friends) are tracked separately in the ledger.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");

const LOCAL_UNIT_CONST =
	/const\s+(?:SECOND_MS|MINUTE_MS|HOUR_MS|DAY_MS|WEEK_MS|MS_PER_SECOND|MS_PER_MINUTE|MS_PER_HOUR|MS_PER_DAY|SEVEN_DAYS_MS)\s*=/;

async function walk(dir: string, out: string[], includeTests = false): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out, includeTests);
		} else if (entry.name.endsWith(".ts") && (includeTests || !entry.name.endsWith(".test.ts"))) {
			out.push(full);
		}
	}
}

describe("time unit source lock", () => {
	it("no production source defines a local millisecond unit constant outside utils/src/time.ts", async () => {
		const offenders: string[] = [];
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
				if (rel === "utils/src/time.ts") continue;
				const text = await readFile(file, "utf8");
				if (LOCAL_UNIT_CONST.test(text)) offenders.push(rel);
			}
		}
		expect(
			offenders,
			"local time-unit const copies: import SECOND_MS/MINUTE_MS/HOUR_MS/DAY_MS/WEEK_MS from @veyyon/utils instead",
		).toEqual([]);
	});
});
