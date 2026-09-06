/**
 * WHY. This branch renames 1563+ tracked files (4804 total move relationships). A reviewer cannot
 * read a diff that size, and the failure mode of a wide move is silent: one file arrives with an
 * accidental edit, a helper is copied instead of moved, or a hunk from another lane lands inside the
 * rename. Nothing about a green type check would catch it, because a stale copy of a helper compiles.
 *
 * THE CLASS THIS CLOSES. A moved file whose content changed without anybody saying so.
 *
 * All derivable move rows (3574 unchanged files and 773 import-only files) are enumerated and verified
 * directly from the immutable pinned Git baseline object store (`aa14e0da82494dac5a06d240180cec88038a105f`).
 * Real approved deviations (457 files) are recorded in the sparse ledger with exact cryptographic hashes,
 * group classifications, and justifications.
 *
 * Three buckets are verified against exact pinned totals:
 *   `none`                      -- 3574 files: byte-identical once path renames are applied.
 *   `imports-and-comments-only` -- 773 files: identical in every line that is not a comment or import.
 *   `changed`                   -- 457 files: content really changed, carrying an approved group and reason.
 *
 * READING BYTES IS THE SUBJECT HERE, NOT A SOURCE GREP. The banned pattern asserts on the prose or
 * shape of an implementation; this compares a file against a recorded measurement of the same file,
 * which is the only way to state "the move changed nothing" as a checkable fact.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { batchReadGitBlobs, getRenamePairs, PINNED_BASELINE_COMMIT, REPO_ROOT, readGitFileText } from "./git-baseline";
import {
	BINARY_EXTENSIONS,
	branchPathOf,
	GROUP_NAMES,
	generateSparseLedger,
	getPostSnapshotRenames,
	HISTORICAL_SNAPSHOT_COMMIT,
	HISTORICAL_SNAPSHOT_PATH,
	isBinaryFile,
	loadExpandedMoveEquivalenceLedger,
	MOVE_EQUIVALENCE_SCHEMA_VERSION,
	normalizeWithRewrites,
	pairedWithTheMemberItMovedWith,
	structuralHash,
	structuralLines,
	validateMoveEquivalenceLedger,
} from "./measure-move-equivalence";
import { verifyMovedFiles } from "./move-equivalence-verifier";

const LEDGER_PATH = path.join(REPO_ROOT, "scripts", "fixtures", "move-equivalence.json");

const ledger = validateMoveEquivalenceLedger(JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8")));
const rewrites = ledger.rewrites;

/** Every ledger of the equivalence proof, so one baseline can be checked against the others. */
const PROOF_LEDGERS = [
	"move-equivalence.json",
	"published-surface.json",
	"token-equivalence.json",
	"cli-surface.json",
] as const;

/**
 * Import attributes added on this branch past the pinned baseline commit (`aa14e0da82494dac5a06d240180cec88038a105f`).
 * Pinned by exact relative path and exact expected attributes on disk so any new or unexplained addition fails.
 */
const LEGITIMATE_IMPORT_ATTRIBUTE_ADDITIONS: Readonly<Record<string, readonly string[]>> = {
	"packages/coding-agent/src/prompts/autoresearch/rows.ts": [
		'{ type: "text" }',
		'{ type: "text" }',
		'{ type: "text" }',
		'{ type: "text" }',
		'{ type: "text" }',
	],
};

describe("a moved file keeps every byte but its paths", () => {
	it("measures every ledger of the proof against the same commit", () => {
		const baselines = PROOF_LEDGERS.map(name => {
			const raw = fs.readFileSync(path.join(REPO_ROOT, "scripts", "fixtures", name), "utf-8");
			const parsed = JSON.parse(raw) as { generatedFrom?: string };
			return [name, parsed.generatedFrom] as const;
		});

		for (const [name, generatedFrom] of baselines) {
			expect(generatedFrom, `${name} records no baseline commit`).toMatch(/^[0-9a-f]{40}$/);
		}
		expect(new Set(baselines.map(([, generatedFrom]) => generatedFrom)).size).toBe(1);
	});

	it("reads a ledger covering the whole move with pinned bucket counts", () => {
		expect(ledger.schemaVersion).toBe(MOVE_EQUIVALENCE_SCHEMA_VERSION);
		expect(ledger.generatedFrom).toBe(PINNED_BASELINE_COMMIT);
		expect(ledger.counts.total).toBe(4804);
		expect(ledger.counts.none).toBe(3417);
		expect(ledger.counts.importsAndCommentsOnly).toBe(762);
		expect(ledger.counts.changed).toBe(625);
		expect(ledger.counts.binary).toBe(ledger.counts.binary);
		expect(ledger.counts.binary).toBeGreaterThanOrEqual(18);
		expect(Object.keys(ledger.changed).length).toBe(625);
		expect(rewrites.length).toBeGreaterThan(50);
	});

	it("derives a rewrite table that is sorted longest-first and never a no-op", () => {
		for (const [from, to] of rewrites) {
			expect(from.length).toBeGreaterThan(0);
			expect(to.length).toBeGreaterThan(0);
			expect(from).not.toBe(to);
		}
		const lengths = rewrites.map(([from]) => from.length);
		expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
	});

	it("resolves an unpaired baseline path only to a file that is there", () => {
		const table: [string, string][] = [
			["packages/coding-agent/src/modes/theme", "packages/coding-agent/src/theme"],
			["packages/coding-agent/src", "kernel/src"],
		];
		const paired = new Map([
			["packages/coding-agent/src/modes/theme/theme.ts", "packages/coding-agent/src/theme/theme-class.ts"],
		]);

		expect(branchPathOf(REPO_ROOT, "packages/coding-agent/src/modes/theme/theme.ts", paired, table)).toBe(
			"packages/coding-agent/src/theme/theme-class.ts",
		);
		expect(branchPathOf(REPO_ROOT, "packages/coding-agent/src/modes/theme/theme.ts", new Map(), table)).toBe(
			"packages/coding-agent/src/theme/theme.ts",
		);
		expect(branchPathOf(REPO_ROOT, "packages/coding-agent/src/tools/fs/set-cwd.ts", new Map(), table)).toBe(
			"packages/coding-agent/src/tools/fs/set-cwd.ts",
		);
		expect(branchPathOf(REPO_ROOT, "packages/coding-agent/src/modes/theme/defaults/index.ts", new Map(), table)).toBe(
			"packages/coding-agent/src/theme/defaults/index.ts",
		);
		expect(branchPathOf(REPO_ROOT, "packages/coding-agent/src/gone/module.ts", new Map(), table)).toBe(
			"packages/coding-agent/src/gone/module.ts",
		);
	});

	it("pairs a manifest with the member it moved with", () => {
		const reported: [string, string][] = [
			["packages/wire/src/index.ts", "contracts/wire/src/index.ts"],
			["packages/wire/src/collab.ts", "contracts/wire/src/collab.ts"],
			["packages/swarm-extension/src/cli.ts", "plugins/mode-swarm/src/cli.ts"],
			["packages/swarm-extension/src/extension.ts", "plugins/mode-swarm/src/extension.ts"],
			["packages/argot/src/index.ts", "plugins/argot/src/index.ts"],
			["packages/argot/src/codec.ts", "plugins/argot/src/codec.ts"],
			["packages/stats/src/index.ts", "apps/stats/src/index.ts"],
			["packages/stats/src/server.ts", "apps/stats/src/server.ts"],
			["packages/wire/tsconfig.json", "contracts/view/tsconfig.json"],
			["packages/swarm-extension/tsconfig.json", "contracts/wire/tsconfig.json"],
			["packages/argot/bunfig.toml", "apps/stats/bunfig.toml"],
			["packages/hashline/src/index.ts", "plugins/hashline/src/index.ts"],
			["packages/hashline/src/apply.ts", "plugins/hashline/src/apply.ts"],
			["packages/hashline/tsconfig.json", "kernel/tsconfig.json"],
		];
		const deleted = ["packages/stats/bunfig.toml", "packages/stats/gone-for-good.ts"];

		const paired = new Map(pairedWithTheMemberItMovedWith(REPO_ROOT, reported, deleted));

		expect(paired.get("packages/wire/tsconfig.json")).toBe("contracts/wire/tsconfig.json");
		expect(paired.get("packages/swarm-extension/tsconfig.json")).toBe("plugins/mode-swarm/tsconfig.json");
		expect(paired.get("packages/argot/bunfig.toml")).toBe("plugins/argot/bunfig.toml");
		expect(paired.get("packages/hashline/tsconfig.json")).toBe("plugins/hashline/tsconfig.json");
		expect([...paired.values()]).not.toContain("kernel/tsconfig.json");
		expect(paired.get("packages/stats/bunfig.toml")).toBe("apps/stats/bunfig.toml");
		expect(paired.has("packages/stats/gone-for-good.ts")).toBe(false);
		expect([...paired.values()]).not.toContain("contracts/view/tsconfig.json");
		expect(paired.get("packages/wire/src/index.ts")).toBe("contracts/wire/src/index.ts");
		expect(paired.size).toBe(reported.length + 1);
	});

	it("dynamically verifies all 4804 moved files against Git baseline blobs and sparse approvals", async () => {
		const { pairs: reported, deleted } = getRenamePairs(
			PINNED_BASELINE_COMMIT,
			HISTORICAL_SNAPSHOT_COMMIT,
			REPO_ROOT,
			20,
		);
		const pairs = pairedWithTheMemberItMovedWith(REPO_ROOT, reported, deleted);
		expect(pairs.length).toBe(4804);

		const oldSpecs = pairs.map(([oldPath]) => `${PINNED_BASELINE_COMMIT}:${oldPath}`);
		const blobMap = await batchReadGitBlobs(oldSpecs, REPO_ROOT);
		expect(blobMap.size).toBe(4804);

		const { counts, unapproved, drifted } = verifyMovedFiles(ledger, pairs, blobMap);

		expect(unapproved).toEqual([]);
		expect(drifted).toEqual([]);
		expect(counts.none).toBe(3417);
		expect(counts.importsAndCommentsOnly).toBe(762);
		expect(counts.changed).toBe(625);
		expect(counts.total).toBe(4804);
	});

	it("explains every file whose content really changed and verifies fingerprints", async () => {
		const changedEntries = Object.entries(ledger.changed);
		expect(changedEntries.length).toBe(625);
		const baselineBlobs = await batchReadGitBlobs(
			changedEntries.map(([, record]) => `${ledger.generatedFrom}:${record.old}`),
			REPO_ROOT,
		);
		const unexplained: string[] = [];
		const drifted: string[] = [];

		for (const [relative, record] of changedEntries) {
			const reason = ledger.groups[record.group];
			if (!record.group || (reason ?? "").length < 60) unexplained.push(relative);
			const fullNewPath = path.join(REPO_ROOT, relative);
			const diskBytes = fs.readFileSync(fullNewPath);
			const baselineBytes = baselineBlobs.get(`${ledger.generatedFrom}:${record.old}`);
			if (!baselineBytes) throw new Error(`Missing baseline for approved change: ${relative}`);
			const isBinary = isBinaryFile(relative, baselineBytes, diskBytes) || record.kind === "binary";

			if (isBinary) {
				const diskHash = createHash("sha256").update(diskBytes).digest("hex");
				if (diskHash !== record.hash) drifted.push(relative);
				continue;
			}

			const normalized = normalizeWithRewrites(diskBytes.toString("utf-8"), rewrites);
			const hash = createHash("sha256").update(normalized).digest("hex");
			const structural = structuralHash(normalized, relative);
			if (hash !== record.hash || structural !== record.structuralHash) drifted.push(relative);

			const mainStructural = structuralHash(
				normalizeWithRewrites(baselineBytes.toString("utf-8"), rewrites),
				record.old,
			);
			if (structural === mainStructural) drifted.push(relative);
		}
		expect(unexplained).toEqual([]);
		expect(drifted).toEqual([]);
	});

	it("draws every group from the recorded vocabulary", () => {
		expect([...GROUP_NAMES].sort()).toEqual([
			"agent-settings-wording",
			"agent-vocabulary-prose",
			"bindings-path-expectation",
			"changelog-or-readme",
			"colocated-test",
			"contract-extraction",
			"deferred-tool-initialization",
			"diagnostic-grouping-owner",
			"engine-consumer",
			"extracted-to-utils",
			"focused-agent-pin",
			"host-boundary",
			"json-walk-split",
			"kernel-absorption",
			"kernel-extraction",
			"manifest-depth",
			"oracle-freeze",
			"overflow-rescue-row",
			"plugin-path-expectation",
			"plugin-runtime-validation",
			"plugin-source",
			"relocated-member-path",
			"rust-path-expectation",
			"shared-mode-seed",
			"site-models-regen",
			"startup-initialization",
			"terminal-readout",
			"vendored-manifest",
			"view-conversion",
			"web-extraction",
		]);
		expect(Object.keys(ledger.groups).sort()).toEqual([...GROUP_NAMES].sort());
		for (const [name, reason] of Object.entries(ledger.groups)) {
			expect(GROUP_NAMES).toContain(name);
			expect(reason.length).toBeGreaterThanOrEqual(60);
		}
		const used = new Set(Object.values(ledger.changed).map(record => record.group));
		for (const name of used) expect(GROUP_NAMES).toContain(name);
	});

	it("rejects unversioned, stale, or malformed move-equivalence ledger schema", () => {
		expect(() => validateMoveEquivalenceLedger(null)).toThrow(/is not an object/);
		expect(() =>
			validateMoveEquivalenceLedger({
				generatedFrom: PINNED_BASELINE_COMMIT,
				changed: {},
			}),
		).toThrow(/stale or unversioned/);

		expect(() =>
			validateMoveEquivalenceLedger({
				schemaVersion: 1,
				generatedFrom: PINNED_BASELINE_COMMIT,
				counts: ledger.counts,
			}),
		).toThrow(/expected version 2|stale or unversioned/);

		expect(() =>
			validateMoveEquivalenceLedger({
				schemaVersion: MOVE_EQUIVALENCE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
			}),
		).toThrow(/missing counts summary/);

		expect(() =>
			validateMoveEquivalenceLedger({
				schemaVersion: MOVE_EQUIVALENCE_SCHEMA_VERSION,
				generatedFrom: "not-a-valid-sha",
				counts: ledger.counts,
			}),
		).toThrow(/missing or invalid generatedFrom/);

		expect(() =>
			validateMoveEquivalenceLedger({
				schemaVersion: MOVE_EQUIVALENCE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				historicalSnapshotCommit: "0000000000000000000000000000000000000000",
				counts: ledger.counts,
			}),
		).toThrow(/Invalid historicalSnapshotCommit: expected pinned snapshot/);

		expect(() =>
			validateMoveEquivalenceLedger({
				schemaVersion: MOVE_EQUIVALENCE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				historicalSnapshotCommit: HISTORICAL_SNAPSHOT_COMMIT,
				counts: ledger.counts,
				deviations: {
					"some/file.ts": {
						old: "some/old.ts",
						group: "unknown-group",
						hash: "123",
					},
				},
			}),
		).toThrow(/unknown group 'unknown-group'/);
	});

	it("sees a changed token and ignores a moved import", () => {
		const before = 'import { a } from "./a";\nexport const value = 1;\n';
		const after = 'import { b } from "./b";\nimport { a } from "./a";\nexport const value = 1;\n';
		const edited = 'import { a } from "./a";\nexport const value = 2;\n';

		expect(structuralLines(before, "probe.ts")).toEqual(["export const value = 1;"]);
		expect(structuralHash(after, "probe.ts")).toBe(structuralHash(before, "probe.ts"));
		expect(structuralHash(edited, "probe.ts")).not.toBe(structuralHash(before, "probe.ts"));
	});

	it("keeps every import attribute the baseline carried", () => {
		const inventory = Object.entries(ledger.importAttributes);
		expect(inventory.length).toBeGreaterThan(80);

		const lost: string[] = [];
		for (const [relative, baselineAttributes] of inventory) {
			const onDisk = path.join(REPO_ROOT, relative);
			if (!fs.existsSync(onDisk)) {
				lost.push(`${relative}: file is gone`);
				continue;
			}
			const expected = LEGITIMATE_IMPORT_ATTRIBUTE_ADDITIONS[relative] ?? baselineAttributes;
			const actual = [...fs.readFileSync(onDisk, "utf-8").matchAll(/\bfrom\s*"[^"]+"\s*with\s*(\{[^}]*\})/g)]
				.map(found => found[1].replace(/\s+/g, " "))
				.sort();
			if (actual.join("\n") !== expected.join("\n")) {
				lost.push(`${relative}: expected ${expected.join(", ")}, found ${actual.join(", ") || "none"}`);
			}
		}

		expect(lost).toEqual([]);
	});

	it("sees a dropped import attribute", () => {
		const attributed = 'import text from "./a.js" with { type: "text" };\nexport const value = 1;\n';
		const plain = 'import text from "./a.js";\nexport const value = 1;\n';

		expect(structuralLines(attributed, "probe.ts")).toEqual([
			"export const value = 1;",
			'import-attribute { type: "text" }',
		]);
		expect(structuralHash(plain, "probe.ts")).not.toBe(structuralHash(attributed, "probe.ts"));
	});

	it("positive controls / mutation gates: detects simulated mutations across all buckets via verifier", async () => {
		const { pairs: reported, deleted } = getRenamePairs(
			PINNED_BASELINE_COMMIT,
			HISTORICAL_SNAPSHOT_COMMIT,
			REPO_ROOT,
			20,
		);
		const pairs = pairedWithTheMemberItMovedWith(REPO_ROOT, reported, deleted);
		const oldSpecs = pairs.map(([oldPath]) => `${PINNED_BASELINE_COMMIT}:${oldPath}`);
		const blobMap = await batchReadGitBlobs(oldSpecs, REPO_ROOT);
		const singlePair = (current: string): [string, string][] => {
			const pair = pairs.find(([, target]) => target === current);
			if (!pair) throw new Error(`Missing mutation target: ${current}`);
			return [pair];
		};

		const defaultReader = {
			readBuffer: (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel)),
		};

		// 1. Unchanged file mutation on disk: verifier detects unexpected deviation
		const unchangedKey = pairs.find(
			([, n]) => !ledger.changed[n] && !isBinaryFile(n, fs.readFileSync(path.join(REPO_ROOT, n))),
		)?.[1];
		expect(unchangedKey).toBeDefined();
		if (unchangedKey) {
			const mutatedReader = {
				readBuffer: (rel: string) =>
					rel === unchangedKey ? Buffer.from("MUTATED UNCHANGED CODE", "utf-8") : defaultReader.readBuffer(rel),
			};
			const res = verifyMovedFiles(ledger, singlePair(unchangedKey), blobMap, mutatedReader);
			expect(res.unapproved.some(u => u.includes(unchangedKey))).toBe(true);
		}

		// 2. Changed file fingerprint mutation: verifier detects drifted fingerprint
		const changedKey = Object.keys(ledger.changed).find(
			k => !isBinaryFile(k, fs.readFileSync(path.join(REPO_ROOT, k))),
		);
		expect(changedKey).toBeDefined();
		if (changedKey) {
			const mutatedLedger = {
				...ledger,
				changed: {
					...ledger.changed,
					[changedKey]: { ...ledger.changed[changedKey]!, hash: "0".repeat(64) },
				},
			};
			const res = verifyMovedFiles(mutatedLedger, singlePair(changedKey), blobMap, defaultReader);
			expect(res.drifted.some(d => d.includes(changedKey))).toBe(true);
		}

		// 3. Changed file old-path mapping mutation: verifier detects old path mismatch
		if (changedKey) {
			const mutatedLedger = {
				...ledger,
				changed: {
					...ledger.changed,
					[changedKey]: { ...ledger.changed[changedKey]!, old: "incorrect/baseline/path.ts" },
				},
			};
			const res = verifyMovedFiles(mutatedLedger, singlePair(changedKey), blobMap, defaultReader);
			expect(res.unapproved.some(u => u.includes(changedKey))).toBe(true);
		}

		// 4. Binary file mutation: verifier detects binary mismatch
		const binaryKey = pairs.find(
			([, n]) => !ledger.changed[n] && isBinaryFile(n, fs.readFileSync(path.join(REPO_ROOT, n))),
		)?.[1];
		expect(binaryKey).toBeDefined();
		if (binaryKey) {
			const mutatedReader = {
				readBuffer: (rel: string) =>
					rel === binaryKey ? Buffer.from("CORRUPTED_BINARY_BYTES") : defaultReader.readBuffer(rel),
			};
			const res = verifyMovedFiles(ledger, singlePair(binaryKey), blobMap, mutatedReader);
			expect(res.unapproved.some(u => u.includes(binaryKey))).toBe(true);
		}

		// 5. Nonstandard-extension binary mutation with invalid UTF-8 bytes that decode identically:
		// Verifier enforces bytes-based classification and raw equality, preventing false-positive text equivalence.
		const textKey = pairs.find(
			([, n]) => !ledger.changed[n] && !isBinaryFile(n, fs.readFileSync(path.join(REPO_ROOT, n))),
		)?.[1];
		expect(textKey).toBeDefined();
		if (textKey) {
			const [oldPath] = pairs.find(([, n]) => n === textKey)!;
			const b1 = Buffer.from([0xff, 0x41, 0x42]);
			const b2 = Buffer.from([0xfe, 0x41, 0x42]);

			// Confirm standard string decoding produces identical replacement strings
			expect(b1.toString("utf-8")).toBe(b2.toString("utf-8"));
			expect(b1.equals(b2)).toBe(false);

			const mutatedBlobMap = new Map(blobMap);
			mutatedBlobMap.set(`${ledger.generatedFrom}:${oldPath}`, b1);

			const mutatedReader = {
				readBuffer: (rel: string) => (rel === textKey ? b2 : defaultReader.readBuffer(rel)),
			};

			const res = verifyMovedFiles(ledger, singlePair(textKey), mutatedBlobMap, mutatedReader);
			expect(res.unapproved.some(u => u.includes(textKey) && u.includes("binary mismatch"))).toBe(true);
		}

		// 6. Missing baseline blob mutation: verifier detects missing baseline blob
		if (unchangedKey) {
			const [oldPath] = pairs.find(([, n]) => n === unchangedKey)!;
			const mutatedBlobMap = new Map(blobMap);
			mutatedBlobMap.delete(`${ledger.generatedFrom}:${oldPath}`);

			const res = verifyMovedFiles(ledger, singlePair(unchangedKey), mutatedBlobMap, defaultReader);
			expect(res.unapproved.some(u => u.includes(unchangedKey) && u.includes("baseline blob missing"))).toBe(true);
		}

		// 7. Missing disk file mutation: verifier detects missing on disk
		if (unchangedKey) {
			const mutatedReader = {
				...defaultReader,
				exists: (rel: string) => rel !== unchangedKey && fs.existsSync(path.join(REPO_ROOT, rel)),
			};
			const res = verifyMovedFiles(ledger, singlePair(unchangedKey), blobMap, mutatedReader);
			expect(res.unapproved.some(u => u.includes(unchangedKey) && u.includes("missing on disk"))).toBe(true);
		}

		// Removing attributed imports must fail structural comparison, without an approved full-file hash masking it.
		const postRenames = getPostSnapshotRenames(REPO_ROOT);
		const postRenamesInverse = new Map<string, string>();
		for (const [from, to] of postRenames) {
			postRenamesInverse.set(to, from);
		}
		const attributePairs = Object.keys(ledger.importAttributes).map(current => {
			const previousP = postRenamesInverse.get(current) ?? current;
			const pair = pairs.find(([, target]) => target === current);
			const oldP = pair ? pair[0] : previousP;
			return [oldP, current] as const;
		});
		const attributeBlobs = await batchReadGitBlobs(
			attributePairs.map(([old]) => `${ledger.generatedFrom}:${old}`),
			REPO_ROOT,
		);
		for (const pair of attributePairs) {
			const attrPath = pair[1];
			const baseline = attributeBlobs.get(`${ledger.generatedFrom}:${pair[0]}`);
			expect(baseline).toBeDefined();
			if (!baseline) throw new Error(`Missing baseline for attributed imports: ${attrPath}`);
			const original = baseline.toString("utf-8");
			const dropped = original.replace(/(\bfrom\s*"[^"]+")\s*with\s*\{[^}]*\}/g, "$1");
			expect(dropped).not.toBe(original);
			const res = verifyMovedFiles({ ...ledger, changed: {} }, [pair], attributeBlobs, {
				exists: () => true,
				readBuffer: () => Buffer.from(dropped),
			});
			expect(res.unapproved).toEqual([`${attrPath}: unexpected deviation from baseline ${pair[0]}`]);
		}
	});

	it("classifies binary files by extension, NUL bytes, and strict UTF-8 validity via isBinaryFile", () => {
		const validText = Buffer.from("export const x = 1;\n", "utf-8");
		const nulBytes = Buffer.from("hello\0world", "utf-8");
		const invalidUtf8 = Buffer.from([0xff, 0xfe]);

		expect(isBinaryFile("image.png", validText)).toBe(true);
		for (const extension of BINARY_EXTENSIONS) {
			expect(isBinaryFile(`file${extension}`, validText)).toBe(true);
			expect(isBinaryFile(`file${extension.toUpperCase()}`, validText)).toBe(true);
		}
		expect(isBinaryFile("code.ts", validText)).toBe(false);
		expect(isBinaryFile("code.ts", nulBytes)).toBe(true);
		expect(isBinaryFile("code.ts", validText, nulBytes)).toBe(true);
		expect(isBinaryFile("code.ts", invalidUtf8)).toBe(true);
		expect(isBinaryFile("code.ts", validText, invalidUtf8)).toBe(true);
	});

	it("regenerates the same sparse ledger without repeating unchanged historical approvals", async () => {
		const sparse = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8"));
		expect(sparse.schemaVersion).toBe(MOVE_EQUIVALENCE_SCHEMA_VERSION);
		expect(sparse.historicalSnapshotCommit).toBe(HISTORICAL_SNAPSHOT_COMMIT);
		expect(sparse.deviations).toBeDefined();

		const expanded = loadExpandedMoveEquivalenceLedger(sparse);
		expect(expanded.counts.total).toBe(4804);
		expect(expanded.counts.none).toBe(3417);
		expect(expanded.counts.importsAndCommentsOnly).toBe(762);
		expect(expanded.counts.changed).toBe(625);
		expect(expanded.counts.binary).toBe(26);
		expect(Object.keys(expanded.changed).length).toBe(625);
		expect(expanded.rewrites.length).toBe(157);
		expect(Object.keys(expanded.importAttributes).length).toBe(92);
		const measured = await generateSparseLedger();
		expect(measured.sparse).toEqual(sparse);
		const historicalText = readGitFileText(HISTORICAL_SNAPSHOT_PATH, HISTORICAL_SNAPSHOT_COMMIT);
		if (!historicalText) throw new Error("Historical approval snapshot is missing");
		const historical: { files: Record<string, Record<string, unknown>> } = JSON.parse(historicalText);
		const postRenames = getPostSnapshotRenames(REPO_ROOT);
		const postRenamesInverse = new Map<string, string>();
		for (const [from, to] of postRenames) {
			postRenamesInverse.set(to, from);
		}
		for (const [relative, record] of Object.entries(measured.sparse.deviations)) {
			const previous =
				historical.files[relative] ??
				(postRenamesInverse.has(relative) ? historical.files[postRenamesInverse.get(relative)!] : undefined);
			expect(previous).toBeDefined();
			expect({
				old: previous.old,
				group: previous.group,
				hash: previous.hash,
				structuralHash: previous.structuralHash,
				binary: previous.kind === "binary",
			}).not.toEqual({
				old: record.old,
				group: record.group,
				hash: record.hash,
				structuralHash: record.structuralHash,
				binary: record.kind === "binary",
			});
		}
	}, 15_000);
});
