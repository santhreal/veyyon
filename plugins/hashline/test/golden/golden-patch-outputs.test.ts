/**
 * Golden output lock for the Patcher's operator surface (TS-SUITE-6). Every
 * scenario in patch-scenarios.ts is replayed against a fresh in-memory
 * Patcher and its COMPLETE observable output — per-section results (op,
 * before/after/persisted/written bytes, fileHash, header, firstChangedLine,
 * warnings, moveDest), error messages for failing patches, and the final
 * filesystem state — is diffed byte-for-byte against a checked-in golden
 * JSON. This exists because unit tests each pin one field of one behavior;
 * only the golden pins the WHOLE surface at once, so a refactor or a Rust
 * port cannot silently change any operator-visible byte (a reworded error,
 * a dropped warning, a hash-tag format change, a lost BOM on persist).
 *
 * Update flow (explicit, reviewed — never silent):
 *   UPDATE_GOLDEN=1 bun test test/golden
 * rewrites the golden files; the git diff of test/golden/outputs/ is the
 * reviewable record of the behavior change.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryFilesystem, InMemorySnapshotStore, normalizeToLF, Patch, Patcher, stripBom } from "@veyyon/hashline";
import { SCENARIOS } from "./patch-scenarios";

const OUTPUT_DIR = join(import.meta.dir, "outputs");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

async function renderScenario(scenario: (typeof SCENARIOS)[number]): Promise<string> {
	const fs = new InMemoryFilesystem(scenario.files);
	const snapshots = new InMemorySnapshotStore();
	const tags = new Map<string, string>();
	for (const [path, content] of scenario.files) {
		if (scenario.unrecorded?.includes(path)) continue;
		tags.set(path, snapshots.record(path, normalizeToLF(stripBom(content).text)));
	}
	const tag = (path: string): string => {
		const minted = tags.get(path);
		if (minted === undefined) throw new Error(`scenario ${scenario.name}: no tag recorded for ${path}`);
		return minted;
	};

	const patchText = scenario.patch(tag);
	const observable: Record<string, unknown> = { scenario: scenario.name, patch: patchText };
	try {
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(Patch.parse(patchText));
		observable.sections = result.sections.map(section => ({
			path: section.path,
			op: section.op,
			before: section.before,
			after: section.after,
			persisted: section.persisted,
			written: section.written,
			fileHash: section.fileHash,
			header: section.header,
			firstChangedLine: section.firstChangedLine ?? null,
			warnings: section.warnings,
			moveDest: section.moveDest ?? null,
		}));
	} catch (error) {
		observable.error = error instanceof Error ? error.message : String(error);
	}
	observable.filesystem = Object.fromEntries([...fs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
	return `${JSON.stringify(observable, null, 1)}\n`;
}

describe("golden patch outputs", () => {
	if (UPDATE) mkdirSync(OUTPUT_DIR, { recursive: true });

	for (const scenario of SCENARIOS) {
		it(`pins the full observable output of ${scenario.name}`, async () => {
			const rendered = await renderScenario(scenario);
			const goldenPath = join(OUTPUT_DIR, `${scenario.name}.json`);
			if (UPDATE) writeFileSync(goldenPath, rendered);
			expect(existsSync(goldenPath)).toBe(true);
			expect(rendered).toBe(readFileSync(goldenPath, "utf8"));
		});
	}

	it("has a unique name per scenario", () => {
		expect(new Set(SCENARIOS.map(s => s.name)).size).toBe(SCENARIOS.length);
	});

	it("has no orphan golden files (a deleted scenario must delete its golden)", () => {
		const names = new Set(SCENARIOS.map(s => `${s.name}.json`));
		const orphans = readdirSync(OUTPUT_DIR).filter(f => f.endsWith(".json") && !names.has(f));
		expect(orphans).toEqual([]);
	});

	it("covers both success and error paths", () => {
		const errorScenarios = SCENARIOS.filter(s => s.name.includes("error")).length;
		expect(errorScenarios).toBeGreaterThanOrEqual(4);
		expect(SCENARIOS.length - errorScenarios).toBeGreaterThanOrEqual(9);
	});
});
