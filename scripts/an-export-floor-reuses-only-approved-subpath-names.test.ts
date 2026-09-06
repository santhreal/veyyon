/**
 * WHY: public package export floors are anchored to an approved immutable Git baseline
 * (de0ccbf5a571d9de1285cb4dddeff1cc23f882aa) with sparse additions, replacing thousands of lines
 * of duplicated identifier lists.
 *
 * WHAT THIS CLOSES:
 *  - Loss of approved exported names across all 89 public specifiers (4189 total names).
 *  - Stale, invalid, or unversioned schema formats.
 *  - Commit hash mismatches or missing Git baseline references.
 *  - Corrupted, cyclic, or missing subpath reference graphs in additions and factored sets.
 *  - Inclusion of foreign or invalid name shapes.
 *
 * Runtime importability remains covered by a-package-exports-its-public-surface.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	APPROVED_EXPORT_BASELINE_COMMIT,
	BASELINE_FILE_PATH,
	computeExportFloorLedger,
	EXPORT_FLOOR_SCHEMA_VERSION,
	expandExportFloor,
	factorExportFloor,
	validateExportFloorLedger,
} from "./package-export-floor";
import { REPO_ROOT } from "./workspace-layout";

describe("an export floor reuses only approved subpath names", () => {
	it("preserves exact approved 89 specifiers and 4189 exported names from immutable baseline commit", () => {
		// Independent witness: read raw JSON directly via git show without going through helper
		const rawGitShow = execFileSync("git", ["show", `${APPROVED_EXPORT_BASELINE_COMMIT}:${BASELINE_FILE_PATH}`], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		const expectedFloor = JSON.parse(rawGitShow) as Record<string, string[]>;
		const sortedExpected: Record<string, string[]> = Object.fromEntries(
			Object.entries(expectedFloor).map(([key, names]) => [key, [...names].sort()]),
		);

		// Verify the zero-addition fixture against independent witness
		const baselineFixture = expandExportFloor(
			{
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				generatedFrom: APPROVED_EXPORT_BASELINE_COMMIT,
				additions: {},
			},
			REPO_ROOT,
		);
		expect(Object.keys(baselineFixture).length).toBe(89);
		expect(Object.values(baselineFixture).reduce((sum, names) => sum + names.length, 0)).toBe(4189);
		expect(baselineFixture).toEqual(sortedExpected);

		// Verify the committed baseline file retains every immutable name
		const ledgerRaw: unknown = JSON.parse(
			readFileSync(join(REPO_ROOT, "scripts", "package-exports-baseline.json"), "utf8"),
		);
		const currentFloor = expandExportFloor(ledgerRaw, REPO_ROOT);
		expect(Object.keys(currentFloor).length).toBeGreaterThanOrEqual(89);
		for (const [specifier, expectedNames] of Object.entries(sortedExpected)) {
			const actualNames = currentFloor[specifier];
			expect(actualNames, `current floor must include specifier ${specifier}`).toBeDefined();
			for (const name of expectedNames) {
				expect(actualNames, `specifier ${specifier} must retain immutable name ${name}`).toContain(name);
			}
		}
	});
	it("reuses a complete approved subpath floor without admitting unrelated names", () => {
		const shared = Array.from({ length: 12 }, (_, index) => `value${index}`).sort();
		const baseline = {
			"@example/pkg": [...shared, "own"].sort(),
			"@example/pkg/sub": shared,
			"@example/pkg/unrelated": ["foreign"],
		};
		const factored = factorExportFloor(baseline);
		expect(factored.exports["@example/pkg"]).toEqual({ includes: ["@example/pkg/sub"], names: ["own"] });
		expect(expandExportFloor(factored)).toEqual(baseline);
	});

	it("preserves overlapping and nested approved floors as sorted sets", () => {
		const names = Array.from({ length: 20 }, (_, index) => `value${index}`).sort();
		const baseline = {
			"@example/pkg": names,
			"@example/pkg/a": names.slice(0, 15),
			"@example/pkg/a/nested": names.slice(0, 10),
			"@example/pkg/b": names.slice(10),
			"@example/empty": [],
		};
		expect(expandExportFloor(factorExportFloor(baseline))).toEqual(baseline);
	});

	it("applies sparse additions on top of immutable baseline floor", () => {
		const ledgerWithAdditions = {
			schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
			generatedFrom: APPROVED_EXPORT_BASELINE_COMMIT,
			additions: {
				exports: {
					"@example/new-specifier/sub": ["subOne", "subTwo"],
					"@example/new-specifier": {
						includes: ["@example/new-specifier/sub"],
						names: ["rootOnly"],
					},
					"@veyyon/agent-core": ["__extraApprovedTestExportName__"],
				},
			},
		};
		const expanded = expandExportFloor(ledgerWithAdditions, REPO_ROOT);
		expect(expanded["@example/new-specifier"]).toEqual(["rootOnly", "subOne", "subTwo"]);
		expect(expanded["@veyyon/agent-core"]).toContain("__extraApprovedTestExportName__");
		expect(expanded["@veyyon/agent-core"]).toContain("Agent");
	});

	it("computes sparse additions without repeating immutable baseline names and rejects removals", () => {
		const base = {
			"@example/pkg": ["alpha", "beta"],
			"@example/pkg/sub": ["gamma"],
		};

		// Clean case: no additions
		const noAdditions = computeExportFloorLedger({
			immutableBase: base,
			currentSurface: base,
		});
		expect(noAdditions.schemaVersion).toBe(EXPORT_FLOOR_SCHEMA_VERSION);
		expect(noAdditions.generatedFrom).toBe(APPROVED_EXPORT_BASELINE_COMMIT);
		expect(noAdditions.additions?.exports ?? {}).toEqual({});

		// Clean case: additions added
		const withAdditions = computeExportFloorLedger({
			immutableBase: base,
			approvedFloor: base,
			currentSurface: {
				"@example/pkg": ["alpha", "beta", "delta"],
				"@example/pkg/sub": ["gamma"],
				"@example/new-pkg": ["omega"],
			},
		});
		expect(withAdditions.additions?.exports).toBeDefined();
		const expanded = expandExportFloor(withAdditions, REPO_ROOT, base);
		expect(expanded["@example/pkg"]).toEqual(["alpha", "beta", "delta"]);
		expect(expanded["@example/new-pkg"]).toEqual(["omega"]);

		// Rejection case: removed specifier from approved floor
		expect(() =>
			computeExportFloorLedger({
				immutableBase: base,
				approvedFloor: { ...base, "@example/approved-addition": ["x"] },
				currentSurface: base, // dropped @example/approved-addition
			}),
		).toThrow("Removed specifiers");

		// Rejection case: removed name from approved floor
		expect(() =>
			computeExportFloorLedger({
				immutableBase: base,
				approvedFloor: {
					"@example/pkg": ["alpha", "beta", "previouslyApprovedName"],
					"@example/pkg/sub": ["gamma"],
				},
				currentSurface: base, // dropped previouslyApprovedName
			}),
		).toThrow('missing approved export "previouslyApprovedName"');
	});
	it("preserves multi-generation additions and refuses silent disappearance of previous additions", () => {
		const base = {
			"@example/pkg": ["alpha", "beta"],
			"@example/pkg/sub": ["gamma"],
		};

		// Generation 1: Add "delta" to @example/pkg and introduce @example/new-pkg
		const gen1Surface = {
			"@example/pkg": ["alpha", "beta", "delta"],
			"@example/pkg/sub": ["gamma"],
			"@example/new-pkg": ["omega"],
		};
		const gen1Ledger = computeExportFloorLedger({
			immutableBase: base,
			currentSurface: gen1Surface,
		});
		const gen1Floor = expandExportFloor(gen1Ledger, REPO_ROOT, base);
		expect(gen1Floor["@example/pkg"]).toEqual(["alpha", "beta", "delta"]);
		expect(gen1Floor["@example/new-pkg"]).toEqual(["omega"]);

		// Generation 2: Add "epsilon" to @example/pkg, "theta" to @example/pkg/sub, "psi" to @example/new-pkg
		const gen2Surface = {
			"@example/pkg": ["alpha", "beta", "delta", "epsilon"],
			"@example/pkg/sub": ["gamma", "theta"],
			"@example/new-pkg": ["omega", "psi"],
		};
		const gen2Ledger = computeExportFloorLedger({
			immutableBase: base,
			approvedFloor: gen1Floor,
			currentSurface: gen2Surface,
		});

		// Verify sparse delta is relative to immutable base (does not duplicate base names)
		expect(gen2Ledger.additions?.exports?.["@example/pkg"]).toEqual(["delta", "epsilon"]);
		expect(gen2Ledger.additions?.exports?.["@example/pkg/sub"]).toEqual(["theta"]);
		expect(gen2Ledger.additions?.exports?.["@example/new-pkg"]).toEqual(["omega", "psi"]);

		// Expanding Gen 2 ledger must losslessly produce full surface
		const gen2Floor = expandExportFloor(gen2Ledger, REPO_ROOT, base);
		expect(gen2Floor).toEqual(gen2Surface);

		// Refusal: Dropping Generation 1 addition "delta" when generating Gen 2 must fail closed
		const droppedGen1NameSurface = {
			"@example/pkg": ["alpha", "beta", "epsilon"], // dropped "delta"
			"@example/pkg/sub": ["gamma", "theta"],
			"@example/new-pkg": ["omega", "psi"],
		};
		expect(() =>
			computeExportFloorLedger({
				immutableBase: base,
				approvedFloor: gen1Floor,
				currentSurface: droppedGen1NameSurface,
			}),
		).toThrow('missing approved export "delta"');

		// Refusal: Dropping Generation 1 added specifier @example/new-pkg must fail closed
		const droppedGen1SpecifierSurface = {
			"@example/pkg": ["alpha", "beta", "delta", "epsilon"],
			"@example/pkg/sub": ["gamma", "theta"],
			// dropped @example/new-pkg
		};
		expect(() =>
			computeExportFloorLedger({
				immutableBase: base,
				approvedFloor: gen1Floor,
				currentSurface: droppedGen1SpecifierSurface,
			}),
		).toThrow("Removed specifiers");

		// Idempotency: Re-generating ledger from the same surface yields stable identical output
		const recomputedGen2 = computeExportFloorLedger({
			immutableBase: base,
			approvedFloor: gen2Floor,
			currentSurface: gen2Surface,
		});
		expect(recomputedGen2).toEqual(gen2Ledger);
	});

	it("isolates non-subpath aliases and prefixes without slash delimiter from factoring", () => {
		const shared = Array.from({ length: 10 }, (_, index) => `shared${index}`);
		const baseline = {
			"@example/pkg": [...shared, "own"].sort(),
			"@example/pkg-alias": shared,
			"@example/pkg2": shared,
			"@example/pkg/sub": shared,
		};
		const factored = factorExportFloor(baseline);
		// Only genuine subpath @example/pkg/sub can be factored into @example/pkg
		expect(factored.exports["@example/pkg"]).toEqual({
			includes: ["@example/pkg/sub"],
			names: ["own"],
		});
		expect(factored.exports["@example/pkg-alias"]).toEqual(shared);
		expect(factored.exports["@example/pkg2"]).toEqual(shared);
		expect(expandExportFloor(factored)).toEqual(baseline);
	});

	it("validates schema and rejects stale, missing, or corrupt ledger structures", () => {
		expect(() => validateExportFloorLedger(null)).toThrow("Export floor schema is stale or invalid");
		expect(() => validateExportFloorLedger({})).toThrow("Export floor schema is stale or invalid");
		expect(() =>
			validateExportFloorLedger({
				schemaVersion: 1,
				generatedFrom: APPROVED_EXPORT_BASELINE_COMMIT,
			}),
		).toThrow("Export floor schema is stale or invalid");
		expect(() =>
			validateExportFloorLedger({
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				generatedFrom: "",
			}),
		).toThrow("missing generatedFrom commit hash");
		expect(() =>
			validateExportFloorLedger({
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				generatedFrom: "0000000000000000000000000000000000000000",
			}),
		).toThrow("generatedFrom commit mismatch");
		expect(() =>
			validateExportFloorLedger({
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				generatedFrom: APPROVED_EXPORT_BASELINE_COMMIT,
				additions: [],
			}),
		).toThrow("additions must be an object");
		expect(() =>
			validateExportFloorLedger({
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				generatedFrom: APPROVED_EXPORT_BASELINE_COMMIT,
				additions: { exports: [] },
			}),
		).toThrow("additions.exports must be an object");
	});

	it.each([
		{ label: "unversioned", raw: { "@example/pkg": ["value"] }, message: "schema is stale or invalid" },
		{
			label: "stale schema version 1",
			raw: { schemaVersion: 1, exports: {} },
			message: "schema is stale or invalid",
		},
		{ label: "unknown version", raw: { schemaVersion: 99, exports: {} }, message: "schema is stale or invalid" },
		{
			label: "array table",
			raw: { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: [] },
			message: "must be an object",
		},
		{
			label: "invalid names",
			raw: { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: { root: [1] } },
			message: "Invalid export floor",
		},
		{
			label: "duplicate names in array",
			raw: { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: { root: ["a", "a"] } },
			message: "Invalid export floor",
		},
		{
			label: "duplicate names in referenced floor",
			raw: {
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				exports: { root: { includes: ["sub"], names: ["a", "a"] }, sub: ["b"] },
			},
			message: "Invalid export floor",
		},
		{
			label: "duplicate includes in referenced floor",
			raw: {
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				exports: { root: { includes: ["sub", "sub"], names: ["a"] }, sub: ["b"] },
			},
			message: "Invalid export floor",
		},
		{
			label: "unknown property in referenced floor",
			raw: {
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				exports: { root: { includes: ["sub"], names: ["a"], extraProp: true }, sub: ["b"] },
			},
			message: "Invalid export floor",
		},
		{
			label: "non-string include in referenced floor",
			raw: {
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				exports: { root: { includes: [123], names: ["a"] } },
			},
			message: "Invalid export floor",
		},
		{
			label: "missing reference",
			raw: { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: { root: { includes: ["absent"], names: [] } } },
			message: "Missing export floor reference",
		},
		{
			label: "self reference",
			raw: { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: { root: { includes: ["root"], names: [] } } },
			message: "Cyclic export floor reference",
		},
		{
			label: "reference cycle",
			raw: {
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				exports: { root: { includes: ["child"], names: [] }, child: { includes: ["root"], names: [] } },
			},
			message: "Cyclic export floor reference",
		},
		{
			label: "three-node reference cycle",
			raw: {
				schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
				exports: {
					a: { includes: ["b"], names: [] },
					b: { includes: ["c"], names: [] },
					c: { includes: ["a"], names: [] },
				},
			},
			message: "Cyclic export floor reference",
		},
	])("rejects $label without producing an export floor", ({ raw, message }) => {
		expect(() => expandExportFloor(raw)).toThrow(message);
	});
});
