/**
 * WHY. This branch renames 3204 tracked files. A reviewer cannot read a diff that size, and the
 * failure mode of a wide move is silent: one file arrives with an accidental edit, a helper is copied
 * instead of moved, or a hunk from another lane lands inside the rename. Nothing about a green type
 * check would catch it, because a stale copy of a helper compiles.
 *
 * THE CLASS THIS CLOSES. A moved file whose content changed without anybody saying so. Every rename
 * pair is recorded with two hashes of main's text and two of the working tree's, and the ledger says
 * which of three things is true of the pair:
 *
 *   `none`                      -- byte-identical once the branch's own path renames are applied.
 *   `imports-and-comments-only` -- identical in every line that is not a comment or an import.
 *   `changed`                   -- content really changed, and the row carries a group and a reason.
 *
 * The ledger is committed data, not a snapshot of an opinion: this suite recomputes every hash from
 * the working tree and fails when one drifts, so an edit to a moved file after the ledger was written
 * turns red until somebody regenerates it and states what changed.
 *
 * READING BYTES IS THE SUBJECT HERE, NOT A SOURCE GREP. The banned pattern asserts on the prose or
 * shape of an implementation; this compares a file against a recorded measurement of the same file,
 * which is the only way to state "the move changed nothing" as a checkable fact.
 *
 * WHAT IT DOES NOT CATCH. A file created in this branch (no baseline to compare with), a file deleted
 * in it (no counterpart), and whether a `changed` row's new behaviour is correct -- the oracle and
 * contract suites answer that. It also cannot see a semantic reorder of two statements inside an
 * `imports-and-comments-only` row, because that comparison keeps line order but not statement order
 * inside an import block. And a regenerated ledger is only as honest as the reason someone wrote in it.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	GROUP_NAMES,
	type MoveEquivalenceLedger,
	normalizeWithRewrites,
	structuralHash,
	structuralLines,
} from "./measure-move-equivalence";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LEDGER_PATH = path.join(REPO_ROOT, "scripts", "fixtures", "move-equivalence.json");

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8")) as MoveEquivalenceLedger;
const rows = Object.entries(ledger.files);
const rewrites = ledger.rewrites;

/** Every ledger of the equivalence proof, so one baseline can be checked against the others. */
const PROOF_LEDGERS = [
	"move-equivalence.json",
	"published-surface.json",
	"token-equivalence.json",
	"cli-surface.json",
] as const;

function readNormalized(relative: string): string {
	return normalizeWithRewrites(fs.readFileSync(path.join(REPO_ROOT, relative), "utf-8"), rewrites);
}

describe("a moved file keeps every byte but its paths", () => {
	/**
	 * The four ledgers are one measurement in four files, and each records the commit it was taken
	 * against. A regeneration that reaches three of them leaves the fourth comparing this branch to a
	 * tree nobody else compared it to, and every cell in that fourth suite still passes: its rows are
	 * self-consistent, they are just answers about a different baseline. That happened — the token
	 * ledger sat two merges behind the other three. So the baselines are asserted equal to each
	 * other, which no single suite can see on its own.
	 */
	it("measures every ledger of the proof against the same commit", () => {
		const baselines = PROOF_LEDGERS.map(name => {
			const raw = fs.readFileSync(path.join(REPO_ROOT, "scripts", "fixtures", name), "utf-8");
			return [name, (JSON.parse(raw) as { generatedFrom?: string }).generatedFrom] as const;
		});

		for (const [name, generatedFrom] of baselines) {
			expect(generatedFrom, `${name} records no baseline commit`).toMatch(/^[0-9a-f]{40}$/);
		}
		expect(new Set(baselines.map(([, generatedFrom]) => generatedFrom)).size).toBe(1);
	});

	/**
	 * Anti-vacuity, before any absence check. Every cell below sweeps `rows`, so an empty or truncated
	 * ledger would pass them all. The counts are pinned by exact equality rather than as floors,
	 * because a floor cannot see a row move between buckets and cannot see a rename the ledger never
	 * recorded: a new rename pair is invisible to every cell below, and a reclassified row is the
	 * difference between "changed nothing" and "changed something". Regenerate with
	 * `bun scripts/measure-move-equivalence.ts` against a checkout that has `origin/main`, then state
	 * which rows moved and why.
	 */
	it("reads a ledger covering the whole move", () => {
		expect(ledger.generatedFrom).toMatch(/^[0-9a-f]{40}$/);
		expect(rows.length).toBe(3204);
		const buckets = new Map<string, number>();
		for (const [, record] of rows) buckets.set(record.differs, (buckets.get(record.differs) ?? 0) + 1);
		expect([...buckets].sort()).toEqual([
			["changed", 131],
			["imports-and-comments-only", 389],
			["none", 2684],
		]);
		expect(rewrites.length).toBeGreaterThan(50);
		const paths = rows.map(([relative]) => relative);
		expect(paths.some(relative => relative.startsWith("natives/"))).toBe(true);
		expect(paths.some(relative => relative.startsWith("hosts/terminal/engine/"))).toBe(true);
		expect(paths.some(relative => relative.startsWith("contracts/"))).toBe(true);
		expect(paths.some(relative => relative.startsWith("plugins/"))).toBe(true);
		expect(paths.some(relative => relative.startsWith("kernel/"))).toBe(true);
		expect(paths.some(relative => relative.endsWith(".rs"))).toBe(true);
	});

	/** A rewrite that maps a prefix to itself, or reaches its target after a shorter rule, rewrites nothing. */
	it("derives a rewrite table that is sorted longest-first and never a no-op", () => {
		for (const [from, to] of rewrites) {
			expect(from.length).toBeGreaterThan(0);
			expect(to.length).toBeGreaterThan(0);
			expect(from).not.toBe(to);
		}
		const lengths = rewrites.map(([from]) => from.length);
		expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
	});

	/** A row for a path that no longer exists is a rename this branch undid, or a ledger nobody regenerated. */
	it("names only paths that exist", () => {
		const missing = rows.filter(([relative]) => !fs.existsSync(path.join(REPO_ROOT, relative)));
		expect(missing.map(([relative]) => relative)).toEqual([]);
	});

	/**
	 * The claim. A `none` row's file still hashes to main's text in this branch's vocabulary, so the
	 * move changed nothing in it, and this is where an edit to one of those files reds the suite.
	 */
	it("keeps every unchanged file byte-identical to main after the rewrites", () => {
		const drifted: string[] = [];
		let unchanged = 0;
		for (const [relative, record] of rows) {
			if (record.differs !== "none") continue;
			unchanged++;
			const hash =
				record.kind === "binary"
					? createHash("sha256")
							.update(fs.readFileSync(path.join(REPO_ROOT, relative)))
							.digest("hex")
					: createHash("sha256").update(readNormalized(relative)).digest("hex");
			if (hash !== record.hash || hash !== record.mainHash) drifted.push(relative);
		}
		expect(drifted).toEqual([]);
		expect(unchanged).toBe(2684);
	});

	/**
	 * The weaker claim, stated separately so it can never be mistaken for the one above: these files
	 * differ from main only in comments and import statements. Recomputed from disk against the hash of
	 * MAIN's structural lines, so the row is checkable without git and a code edit to one of them moves
	 * it into the `changed` bucket instead of passing quietly.
	 */
	it("keeps every import-only file identical in the lines that are not imports or comments", () => {
		const drifted: string[] = [];
		let importOnly = 0;
		for (const [relative, record] of rows) {
			if (record.differs !== "imports-and-comments-only") continue;
			importOnly++;
			const hash = structuralHash(readNormalized(relative), relative);
			if (hash !== record.structuralHash || hash !== record.mainStructuralHash) drifted.push(relative);
		}
		expect(drifted).toEqual([]);
		expect(importOnly).toBe(389);
	});

	/**
	 * Every real change carries a group and a reason, and still differs in the way it was recorded.
	 * Both directions matter: a row that stopped differing is a ledger nobody regenerated, and a row
	 * whose content moved again is a change nobody described.
	 */
	it("explains every file whose content really changed", () => {
		const changed = rows.filter(([, record]) => record.differs === "changed");
		expect(changed.length).toBe(131);
		const unexplained: string[] = [];
		const drifted: string[] = [];
		for (const [relative, record] of changed) {
			if (record.group === undefined || (record.reason ?? "").length < 60) unexplained.push(relative);
			if (record.kind === "binary") continue;
			const normalized = readNormalized(relative);
			const hash = createHash("sha256").update(normalized).digest("hex");
			const structural = structuralHash(normalized, relative);
			if (hash !== record.hash || structural !== record.structuralHash) drifted.push(relative);
			if (structural === record.mainStructuralHash) drifted.push(relative);
		}
		expect(unexplained).toEqual([]);
		expect(drifted).toEqual([]);
	});

	/**
	 * The group vocabulary, pinned. A new kind of change has to be named in the generator, which is
	 * where the reason lives, rather than described in a row nobody else can find.
	 */
	it("draws every group from the recorded vocabulary", () => {
		expect([...GROUP_NAMES].sort()).toEqual([
			"bindings-path-expectation",
			"changelog-or-readme",
			"contract-extraction",
			"engine-consumer",
			"extracted-to-utils",
			"host-boundary",
			"manifest-depth",
			"rust-path-expectation",
			"vendored-manifest",
			"view-conversion",
		]);
		const used = new Set(rows.map(([, record]) => record.group).filter((name): name is string => name !== undefined));
		for (const name of used) expect(GROUP_NAMES).toContain(name);
	});

	/**
	 * Positive controls for both comparisons, so a normalization that swallowed everything would fail
	 * here rather than pass every cell above. The first proves a changed token is visible; the second
	 * proves an import-only difference is invisible to the structural comparison and only to that one.
	 */
	it("sees a changed token and ignores a moved import", () => {
		const before = 'import { a } from "./a";\nexport const value = 1;\n';
		const after = 'import { b } from "./b";\nimport { a } from "./a";\nexport const value = 1;\n';
		const edited = 'import { a } from "./a";\nexport const value = 2;\n';

		expect(structuralLines(before, "probe.ts")).toEqual(["export const value = 1;"]);
		expect(structuralHash(after, "probe.ts")).toBe(structuralHash(before, "probe.ts"));
		expect(structuralHash(edited, "probe.ts")).not.toBe(structuralHash(before, "probe.ts"));
	});

	/**
	 * An import ATTRIBUTE is not an import path, and every cell above was blind to the difference:
	 * they drop whole import statements, and they only cover files that MOVED.
	 * `packages/coding-agent/src/export/html/index.ts` never moved and lost `with { type: "text" }`
	 * from all five of its content imports in `c0bb4a1a0`, which turned five strings into five modules
	 * and made HTML export throw on a missing default export. The type check cannot see it: the
	 * `.d.ts` beside the file declares the string either way.
	 *
	 * This cell sweeps the whole baseline inventory instead of the rename pairs, and pins each file's
	 * attributes by exact equality, so a dropped attribute is red and an added one is a decision
	 * somebody records. The generator throws rather than omitting a baseline file that is gone, so an
	 * absence cannot hide here either.
	 */
	it("keeps every import attribute the baseline carried", () => {
		const inventory = Object.entries(ledger.importAttributes);
		expect(inventory.length).toBeGreaterThan(80);

		const lost: string[] = [];
		for (const [relative, expected] of inventory) {
			const onDisk = path.join(REPO_ROOT, relative);
			if (!fs.existsSync(onDisk)) {
				lost.push(`${relative}: file is gone`);
				continue;
			}
			const actual = [...fs.readFileSync(onDisk, "utf-8").matchAll(/\bfrom\s*"[^"]+"\s*with\s*(\{[^}]*\})/g)]
				.map(found => found[1].replace(/\s+/g, " "))
				.sort();
			if (actual.join("\n") !== expected.join("\n")) {
				lost.push(`${relative}: expected ${expected.join(", ")}, found ${actual.join(", ") || "none"}`);
			}
		}

		expect(lost).toEqual([]);
	});

	/**
	 * The mutation gate for the cell above and for the classifier it depends on: a lost attribute must
	 * be a structural difference, not an import-shaped one. Without this, `structuralLines` could go
	 * back to dropping the attribute with the statement and every row would stay green.
	 */
	it("sees a dropped import attribute", () => {
		const attributed = 'import text from "./a.js" with { type: "text" };\nexport const value = 1;\n';
		const plain = 'import text from "./a.js";\nexport const value = 1;\n';

		expect(structuralLines(attributed, "probe.ts")).toEqual([
			"export const value = 1;",
			'import-attribute { type: "text" }',
		]);
		expect(structuralHash(plain, "probe.ts")).not.toBe(structuralHash(attributed, "probe.ts"));
	});
});
