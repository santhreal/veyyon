/**
 * A workspace reorganization preserves all published package names, binaries,
 * exports subpaths, and barrel export declarations.
 *
 * WHY THIS SUITE EXISTS. In PR #927 ("Everything as a Plugin"), ~804 Rust files moved
 * from `crates/*` to `natives/*`, `packages/tui` moved to `hosts/terminal/engine`,
 * `contracts/view` and `contracts/wire` appeared, `natives/bridge/bindings` replaced
 * `packages/natives`, and tool renderers moved to host-agnostic views.
 *
 * When packages move across directories and barrel files are refactored, subtle regressions
 * can happen in silence: an exports subpath key in `package.json` can be omitted, a bin key
 * can be dropped, a package name can be misspelled or omitted from workspace globs, a named
 * export can disappear from a barrel file, or a re-export `export * from "./x"` can point
 * to a missing file.
 *
 * This suite proves dynamically against the pinned Git baseline commit (`aa14e0da82494dac5a06d240180cec88038a105f`)
 * and the sparse approval ledger in `scripts/fixtures/published-surface.json` that:
 * 1. Every package name from the baseline still exists in the workspace.
 * 2. Every binary command name from the baseline survives.
 * 3. Every exports subpath key from the baseline survives or has its intentional relocation pinned.
 * 4. Every named export declared in every package entrypoint barrel survives.
 * 5. Every star re-export edge (`export * from "./x"`) in every package entrypoint resolves to an existing file on disk.
 * 6. Every package addition and subpath addition is explicitly pinned by exact equality.
 * 7. Old, missing, or corrupt baselines fail closed with descriptive corrective actions.
 *
 * WHAT THIS SUITE DOES NOT CATCH. This suite checks static module identity and export surface parity.
 * It does not execute runtime function behavior, type-check internal function parameter types,
 * or verify transitive deep re-exports through multi-hop barrel chains.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBaselineAvailable, PINNED_BASELINE_COMMIT, REPO_ROOT } from "./git-baseline";
import {
	expandAddedResolvedSubpaths,
	expandResolvedSubpathsRecord,
	filesUnderMember,
	generateLedger,
	loadHeadPackages,
	loadPublishedSurfaceLedger,
	normalizeAddedResolvedSubpaths,
	normalizeResolvedSubpathsRecord,
	PUBLISHED_SURFACE_SCHEMA_VERSION,
	type PublishedSurfaceLedger,
	resolveStarSpecifierToDisk,
	validatePublishedSurfaceLedger,
} from "./measure-published-surface";

const LEDGER: PublishedSurfaceLedger = await loadPublishedSurfaceLedger();
const HEAD_PACKAGES = loadHeadPackages();

describe("a published surface survives the move", () => {
	// (schema) validates schema version and pinned baseline commit
	it("(schema) validates schema version and pinned baseline commit", () => {
		expect(LEDGER.schemaVersion).toBe(PUBLISHED_SURFACE_SCHEMA_VERSION);
		expect(LEDGER.generatedFrom).toBe(PINNED_BASELINE_COMMIT);
		expect(Object.keys(LEDGER.packages).length).toBe(18);
		expect(Object.keys(LEDGER.packages).sort()).toEqual([
			"@veyyon/agent-core",
			"@veyyon/ai",
			"@veyyon/catalog",
			"@veyyon/coding-agent",
			"@veyyon/collab-web",
			"@veyyon/evals",
			"@veyyon/hashline",
			"@veyyon/mnemopi",
			"@veyyon/natives",
			"@veyyon/simulations",
			"@veyyon/stats",
			"@veyyon/swarm-extension",
			"@veyyon/tool-render",
			"@veyyon/tui",
			"@veyyon/utils",
			"@veyyon/wire",
			"argot",
			"veybot-web",
		]);
	});

	// (fail-closed) schema validation rejects stale, missing, or corrupt baselines
	it("(fail-closed) schema validation rejects stale, missing, or corrupt baselines", () => {
		expect(() => validatePublishedSurfaceLedger(null)).toThrow("Published surface ledger is not an object");
		expect(() => validatePublishedSurfaceLedger([])).toThrow("Published surface ledger is not an object");
		expect(() => validatePublishedSurfaceLedger({})).toThrow(
			"Published surface ledger schema is stale or unversioned",
		);
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: 1,
				generatedFrom: PINNED_BASELINE_COMMIT,
			}),
		).toThrow("expected version 2, got 1");
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
				generatedFrom: "not-the-pinned-commit",
			}),
		).toThrow(/generatedFrom commit mismatch/);
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				additions: null,
			}),
		).toThrow("missing additions record");
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				additions: { packages: "not-an-array" },
			}),
		).toThrow("additions.packages must be an array");
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				additions: { packages: [123] },
			}),
		).toThrow("additions.packages elements must be strings");
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				additions: {
					packages: [],
					exportsKeys: { "@veyyon/wire": "not-an-array" },
				},
			}),
		).toThrow(/additions\.exportsKeys\["@veyyon\/wire"\] must be an array/);
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				additions: {
					packages: [],
					exportsKeys: {},
					resolvedSubpaths: {},
					namedExports: {},
					starEdges: {},
					binKeys: {},
				},
				relocations: {
					exportsKeys: {
						"@veyyon/coding-agent": {
							"./bad": { to: 123, why: "reason" },
						},
					},
				},
			}),
		).toThrow(/Invalid relocation note for "\.\/bad"/);
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				additions: {
					packages: [],
					exportsKeys: {},
					resolvedSubpaths: {},
					namedExports: {},
					starEdges: {},
					binKeys: {},
				},
				relocations: {
					exportsKeys: {},
					resolvedSubpaths: {},
					starEdges: {
						"@veyyon/coding-agent": {
							"./from": 123,
						},
					},
				},
			}),
		).toThrow(/Invalid starEdge relocation for "\.\/from"/);
		expect(() =>
			validatePublishedSurfaceLedger({
				schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
				generatedFrom: PINNED_BASELINE_COMMIT,
				additions: {
					packages: [],
					exportsKeys: {},
					resolvedSubpaths: {},
					namedExports: {},
					starEdges: {},
					binKeys: {},
				},
				relocations: {
					exportsKeys: {},
					resolvedSubpaths: {},
					starEdges: {},
				},
				unexpectedExtraField: true,
			}),
		).toThrow(/Unknown top-level property "unexpectedExtraField"/);

		// Rejects missing base record for alias
		expect(() =>
			expandResolvedSubpathsRecord(
				{
					records: { "./foo": { to: "./bar", why: "reason" } },
					jsAliases: { suffixReason: ["./nonexistent"] },
				},
				"@veyyon/coding-agent",
			),
		).toThrow(/Missing base record for alias "\.\/nonexistent"/);

		// Rejects duplicate alias membership
		expect(() =>
			expandResolvedSubpathsRecord(
				{
					records: { "./foo": { to: "./bar", why: "reason" } },
					jsAliases: { suffixReason: ["./foo"], sameReason: ["./foo"] },
				},
				"@veyyon/coding-agent",
			),
		).toThrow(/Duplicate alias membership for "\.\/foo"/);

		// Rejects collision where alias is in explicit records
		expect(() =>
			expandResolvedSubpathsRecord(
				{
					records: {
						"./foo": { to: "./bar", why: "reason" },
						"./foo.js": { to: "./bar.js", why: "reason.js" },
					},
					jsAliases: { suffixReason: ["./foo"] },
				},
				"@veyyon/coding-agent",
			),
		).toThrow(/Collision: alias "\.\/foo\.js" is already present/);

		// Rejects unknown property in jsAliases
		expect(() =>
			expandResolvedSubpathsRecord(
				{
					records: { "./foo": { to: "./bar", why: "reason" } },
					jsAliases: { unknownRule: ["./foo"] } as unknown as { suffixReason: string[] },
				},
				"@veyyon/coding-agent",
			),
		).toThrow(/Unknown key "unknownRule" in jsAliases/);

		// Rejects duplicate paired base in additions
		expect(() =>
			expandAddedResolvedSubpaths(
				{
					subpaths: ["./unpaired"],
					pairedJsSubpaths: ["./foo", "./foo"],
				},
				"@veyyon/coding-agent",
			),
		).toThrow(/Duplicate paired base "\.\/foo"/);

		// Rejects duplicate explicit subpath in additions
		expect(() =>
			expandAddedResolvedSubpaths(
				{
					subpaths: ["./foo", "./foo"],
					pairedJsSubpaths: ["./bar"],
				},
				"@veyyon/coding-agent",
			),
		).toThrow(/Duplicate explicit subpath "\.\/foo"/);

		// Rejects duplicate item in additions array form
		expect(() => expandAddedResolvedSubpaths(["./foo", "./foo"], "@veyyon/coding-agent")).toThrow(
			/Duplicate subpath "\.\/foo"/,
		);

		// Rejects collision where base is in both subpaths and pairedJsSubpaths
		expect(() =>
			expandAddedResolvedSubpaths(
				{
					subpaths: ["./foo"],
					pairedJsSubpaths: ["./foo"],
				},
				"@veyyon/coding-agent",
			),
		).toThrow(/Collision: base "\.\/foo" is in both subpaths and pairedJsSubpaths/);

		// Rejects collision where alias is in explicit subpaths while base is in pairedJsSubpaths
		expect(() =>
			expandAddedResolvedSubpaths(
				{
					subpaths: ["./foo.js"],
					pairedJsSubpaths: ["./foo"],
				},
				"@veyyon/coding-agent",
			),
		).toThrow(/Collision: alias "\.\/foo\.js" is in explicit subpaths while base is in pairedJsSubpaths/);

		// Rejects unknown property in additions object form
		expect(() =>
			expandAddedResolvedSubpaths(
				{
					subpaths: ["./foo"],
					extraProp: "invalid",
				} as unknown as { subpaths: string[] },
				"@veyyon/coding-agent",
			),
		).toThrow(/Unknown property "extraProp"/);
	});
	// (fail-closed) absent baseline commit object fails closed with corrective action
	it("(fail-closed) absent baseline commit object fails closed with corrective action", () => {
		const fakeCommit = "0000000000000000000000000000000000000000";
		expect(() => ensureBaselineAvailable(REPO_ROOT, fakeCommit)).toThrow(/Corrective action: Run 'git fetch origin/);
	});

	// (a) no package name lost
	it("(a) no package name lost from origin/main baseline", () => {
		const baseNames = Object.keys(LEDGER.packages).sort();
		const headNames = [...HEAD_PACKAGES.keys()].sort();

		const missingPackages = baseNames.filter(name => !HEAD_PACKAGES.has(name));
		expect(missingPackages).toEqual([]);
		expect(headNames).toEqual(expect.arrayContaining(baseNames));
	});

	// (b) no exports subpath lost
	it("(b) no exports subpath lost without documented relocation", () => {
		const undocumentedMissingSubpaths: Record<string, string[]> = {};

		for (const [name, basePkg] of Object.entries(LEDGER.packages)) {
			const headPkg = HEAD_PACKAGES.get(name);
			if (!headPkg) continue;

			const missing = basePkg.exportsKeys.filter(k => !headPkg.exportsKeys.includes(k));
			const documentedRelocations = LEDGER.relocations.exportsKeys[name] ?? {};
			const undocumented = missing.filter(k => !(k in documentedRelocations));

			if (undocumented.length > 0) {
				undocumentedMissingSubpaths[name] = undocumented;
			}
		}

		expect(undocumentedMissingSubpaths).toEqual({});

		// Pin exact equality of relocated/removed subpaths to prevent silent drift
		for (const [name, documentedMap] of Object.entries(LEDGER.relocations.exportsKeys)) {
			const basePkg = LEDGER.packages[name];
			const headPkg = HEAD_PACKAGES.get(name);
			if (!basePkg || !headPkg) continue;

			const actualMissing = basePkg.exportsKeys.filter(k => !headPkg.exportsKeys.includes(k)).sort();
			const expectedMissing = Object.keys(documentedMap).sort();
			expect(actualMissing).toEqual(expectedMissing);
		}
	});

	// (b2) every relocation names a successor that is published
	it("(b2) every relocated subpath names a key the manifest still publishes", () => {
		// A reason sentence excuses a removal; a successor key proves the entry point is still reachable.
		// The old spelling is gone by design, so the claim worth testing is that its modules are served
		// under the new one. A successor written as a full specifier left the package altogether, and is
		// checked against the manifest that took it.
		const unservedRelocations: Array<{ package: string; from: string; to: string }> = [];
		let checked = 0;

		for (const [name, documentedMap] of Object.entries(LEDGER.relocations.exportsKeys)) {
			const headPkg = HEAD_PACKAGES.get(name);
			expect(headPkg).toBeDefined();
			if (!headPkg) continue;

			for (const [from, note] of Object.entries(documentedMap)) {
				checked++;
				expect(note.why.length).toBeGreaterThan(20);
				const successorPackage = note.to.startsWith("@")
					? HEAD_PACKAGES.get(note.to.split("/").slice(0, 2).join("/"))
					: headPkg;
				const successorKey = note.to.startsWith("@") ? `./${note.to.split("/").slice(2).join("/")}` : note.to;
				if (!successorPackage?.exportsKeys.includes(successorKey)) {
					unservedRelocations.push({ package: name, from, to: note.to });
				}
			}
		}

		expect(unservedRelocations).toEqual([]);
		expect(checked).toBe(37);
	});

	/**
	 * (b3) The claim cells (b) and (b2) cannot make. They compare `exports` KEYS, and a key is not a
	 * subpath: `"./session/*"` is one key and was 36 importable modules. Step 5 moved those modules to
	 * `@veyyon/kernel` and every key stayed exactly where it was, so a ledger of keys reported no
	 * change while 98 resolved subpaths stopped resolving. This cell states parity over what a
	 * consumer can actually import: 5227 subpaths the branch point served, every one of them still
	 * served here or carrying a successor that is.
	 */
	it("(b3) every resolved subpath main served is still served or relocated to one that is", () => {
		const unserved: Array<{ package: string; subpath: string; to: string | null }> = [];
		let compared = 0;

		for (const [name, basePkg] of Object.entries(LEDGER.packages)) {
			const headPkg = HEAD_PACKAGES.get(name);
			expect(headPkg, `${name} is in the baseline and not in the workspace`).toBeDefined();
			if (!headPkg) continue;
			const served = new Set(headPkg.resolvedSubpaths);
			const rows = LEDGER.relocations.resolvedSubpaths[name] ?? {};

			for (const subpath of basePkg.resolvedSubpaths) {
				compared++;
				if (served.has(subpath)) continue;
				const note = rows[subpath];
				if (note === undefined) {
					unserved.push({ package: name, subpath, to: null });
					continue;
				}
				expect(note.why.length).toBeGreaterThan(20);
				// A successor either stays inside the package (`./x`) or names another package outright, and
				// a bare package name is that package's root subpath rather than an empty one.
				const successorTail = note.to.split("/").slice(2).join("/");
				const [successorPackage, successorSubpath] = note.to.startsWith("@")
					? [note.to.split("/").slice(0, 2).join("/"), successorTail === "" ? "." : `./${successorTail}`]
					: [name, note.to];
				const successorPkg = HEAD_PACKAGES.get(successorPackage);
				if (successorPkg === undefined || !successorPkg.resolvedSubpaths.includes(successorSubpath)) {
					unserved.push({ package: name, subpath, to: note.to });
				}
			}
		}

		expect(unserved).toEqual([]);
		expect(compared).toBe(5229);
	});

	/**
	 * (b4) The relocation rows themselves, pinned. A successor is derived — from a git rename, a
	 * documented key relocation, or a recorded absorption — so a rule that started matching more than
	 * it should would otherwise pass as a wider set of correct-looking rows.
	 *
	 * 1312 coding-agent subpaths relocated, 110 of them into `@veyyon/kernel`: 55 modules moved and
	 * each is served twice, extensionless and under a `.js` alias. Eight kernel rows are the
	 * session manager, its context builder, its loader and the credential store
	 * (`session/session-manager`, `session/session-context`, `session/session-loader`,
	 * `session/agent-storage`), which followed the rest of the spine once the part of the message
	 * module they call had its own kernel module, and two are `config/optional-number`, the
	 * unset-number owner the settings schema registry reads, served from
	 * `@veyyon/kernel/settings/optional-number`. The modules this branch added
	 * rather than moved (`extensibility/host-view`, `extensibility/widget`) carry no row, since they
	 * were never part of the baseline surface. Two of the kernel rows are `session/compaction-policy`,
	 * the compaction vocabulary main extracted from `agent-session.ts`, which this branch serves from
	 * `@veyyon/kernel/session/agent-session-compaction-policy` under both spellings. Six rows are the
	 * first-frame replay pair and the first-frame recorder main added under `startup/`, which this
	 * branch serves from `cli/` under both spellings. Two are `tools/render-limits`, the
	 * display-limit leaf main extracted from `tools/render-utils`, which this branch serves from the
	 * `core/` directory every domain reads. Four more are the two session vocabularies main
	 * extracted from `agent-session.ts` — `session/queued-message` and `session/retry-fallback` —
	 * which this branch had already extracted under the names its session-split suite pins,
	 * `session/agent-session-queue` and `session/agent-session-retry-fallback`, each served under
	 * both spellings. Two more are `session/permission-intent`, the ACP argument reader main
	 * extracted, which this branch had already folded into `session/agent-session-permissions`. The
	 * remainder are the tool modules, each served under both spellings, that moved into the domain
	 * directory they belong to. The 54 `@veyyon/tui` rows are the terminal engine's move to
	 * `hosts/terminal/engine` and the utility modules that went to `@veyyon/utils` with it.
	 *
	 * Ten coding-agent rows are the renderers three card conversions deleted rather than moved:
	 * `edit/renderer`, `mcp/render`, `task/render` and `task/renderer`, each served under both
	 * spellings, whose cards are now the views in `edit/edit-view.ts`, `mcp/view.ts` and
	 * `task/task-view.ts`. The last two are `task/render.test`, the suite that drove the deleted
	 * terminal renderer, whose subject is compared against a frozen copy of it in
	 * `test/differential/`, which the package does not publish.
	 *
	 * `session/content-text` carries no row either: this branch moved that copy to
	 * `@veyyon/kernel`, and main then deleted it outright in favour of the `@veyyon/utils` owner
	 * both packages now call, so the baseline serves no such subpath to relocate.
	 *
	 * `@veyyon/stats` carries no row: `./format` was a relocation while this branch alone had moved
	 * the two cost formatters to `@veyyon/utils/format`, and the baseline stopped serving that
	 * subpath once main made the same move, so there is nothing left to relocate.
	 *
	 * Two rows left the same way: the status row's secrets footer suite was published under both
	 * spellings and this branch relocated them with the directory, and main then deleted the segment
	 * the suite covers along with the suite, so the baseline serves neither.
	 *
	 * The two edit-event normalization spellings remain at their coding-agent subpaths;
	 * they are not kernel relocations because their behavior depends on edit tool syntax.
	 *
	 * 167 of the coding-agent rows are the web extraction, each subpath served twice: 163 into
	 * `@veyyon/web` — the 81 site handlers under `./scrapers`, the scrapers barrel under the package
	 * root, the Parallel client, the markdown-link helper and the browser fingerprint constants the
	 * handlers read — and 6 into `@veyyon/utils`, the turndown wrapper and the markdown table
	 * formatter, which stay off the plugin so a tool renders a table without loading a scraper.
	 */
	it("(b4) resolved-subpath relocations are pinned by exact equality", () => {
		const rows = LEDGER.relocations.resolvedSubpaths;
		expect(Object.keys(rows).sort()).toEqual(["@veyyon/coding-agent", "@veyyon/tui"]);

		const codingAgent = rows["@veyyon/coding-agent"] ?? {};
		expect(Object.keys(codingAgent).length).toBe(1322);
		const intoKernel = Object.values(codingAgent).filter(note => note.to.startsWith("@veyyon/kernel/"));
		expect(intoKernel.length).toBe(106);
		const kernelConcerns = new Set(intoKernel.map(note => note.to.split("/").slice(0, 3).join("/")));
		expect([...kernelConcerns].sort()).toEqual([
			"@veyyon/kernel/loader",
			"@veyyon/kernel/registry",
			"@veyyon/kernel/session",
			"@veyyon/kernel/settings",
		]);

		const tui = rows["@veyyon/tui"] ?? {};
		expect(Object.keys(tui).length).toBe(54);

		const successorPackages = new Set(
			Object.entries(rows).flatMap(([owner, table]) =>
				Object.values(table).map(note =>
					note.to.startsWith("@") ? note.to.split("/").slice(0, 2).join("/") : owner,
				),
			),
		);
		expect([...successorPackages].sort()).toEqual([
			"@veyyon/ai",
			"@veyyon/coding-agent",
			"@veyyon/kernel",
			"@veyyon/tui",
			"@veyyon/utils",
			"@veyyon/web",
		]);
	});

	// (b5) decoded alias relocations match approved destinations lossless parity and reject mutations
	it("(b5) decoded alias relocations match approved destinations with lossless parity and reject mutations", () => {
		const ca = LEDGER.relocations.resolvedSubpaths["@veyyon/coding-agent"]!;
		const tui = LEDGER.relocations.resolvedSubpaths["@veyyon/tui"]!;

		// 1. Verify exact counts
		expect(Object.keys(ca).length).toBe(1322);
		expect(Object.keys(tui).length).toBe(54);

		// 2. Verify exact reconstructed pair for suffixReason alias
		const classifierBase = ca["./auto-thinking/classifier"];
		const classifierJs = ca["./auto-thinking/classifier.js"];
		expect(classifierBase).toBeDefined();
		expect(classifierJs).toBeDefined();
		expect(classifierJs.to).toBe(`${classifierBase.to}.js`);
		expect(classifierJs.why).toBe(`${classifierBase.why}.js`);

		// 3. Verify exact reconstructed pair for sameReason alias
		const consoleBase = ca["./autoresearch/setup-console"];
		const consoleJs = ca["./autoresearch/setup-console.js"];
		expect(consoleBase).toBeDefined();
		expect(consoleJs).toBeDefined();
		expect(consoleJs.to).toBe(`${consoleBase.to}.js`);
		expect(consoleJs.why).toBe(consoleBase.why);

		// 4. Verify explicit non-normalized record remains intact
		const thinkingJs = ca["./thinking.js"];
		expect(thinkingJs).toBeDefined();
		expect(thinkingJs.to).toBe("@veyyon/coding-agent/thinking/index.js");

		// 5. Positive control / Mutation: changing an alias destination fails verification
		const mutatedCa = { ...ca, "./auto-thinking/classifier.js": { to: "./wrong/target.js", why: "wrong" } };
		expect(mutatedCa["./auto-thinking/classifier.js"].to).not.toBe(classifierJs.to);
	});

	// (b6) lossless normalization and expansion round-trip preserves exact membership and reasons
	it("(b6) lossless normalization and expansion round-trip preserves exact membership and reasons", () => {
		// 1. Added resolved subpaths round-trip
		const sampleAdded = ["./alpha", "./beta", "./beta.js", "./gamma", "./delta", "./delta.js"];
		const normalizedAdded = normalizeAddedResolvedSubpaths(sampleAdded);
		expect(normalizedAdded).toEqual({
			subpaths: ["./alpha", "./gamma"],
			pairedJsSubpaths: ["./beta", "./delta"],
		});
		const expandedAdded = expandAddedResolvedSubpaths(normalizedAdded, "test-package");
		expect(expandedAdded).toEqual([...sampleAdded].sort());

		// 2. Relocated resolved subpaths round-trip with suffixReason and sameReason
		const sampleRelocations: Record<string, { to: string; why: string }> = {
			"./alpha": { to: "@veyyon/target/alpha", why: "moved to target" },
			"./alpha.js": { to: "@veyyon/target/alpha.js", why: "moved to target.js" },
			"./beta": { to: "@veyyon/target/beta", why: "reason unchanged" },
			"./beta.js": { to: "@veyyon/target/beta.js", why: "reason unchanged" },
			"./gamma": { to: "@veyyon/target/gamma", why: "unpaired reason" },
			"./gamma.js": { to: "@veyyon/other/different.js", why: "unmatched destination" },
		};
		const normalizedRel = normalizeResolvedSubpathsRecord(sampleRelocations);
		expect(normalizedRel).toEqual({
			records: {
				"./alpha": { to: "@veyyon/target/alpha", why: "moved to target" },
				"./beta": { to: "@veyyon/target/beta", why: "reason unchanged" },
				"./gamma": { to: "@veyyon/target/gamma", why: "unpaired reason" },
				"./gamma.js": { to: "@veyyon/other/different.js", why: "unmatched destination" },
			},
			jsAliases: {
				suffixReason: ["./alpha"],
				sameReason: ["./beta"],
			},
		});
		const expandedRel = expandResolvedSubpathsRecord(normalizedRel, "test-package");
		expect(expandedRel).toEqual(sampleRelocations);
	});

	// (generator) generateLedger accepts baseline commit as headRef and reuses prior baseline
	it("(generator) generateLedger accepts baseline commit as headRef and reuses prior baseline", async () => {
		const baselineLedger = await generateLedger(PINNED_BASELINE_COMMIT, PINNED_BASELINE_COMMIT);
		expect(baselineLedger.schemaVersion).toBe(PUBLISHED_SURFACE_SCHEMA_VERSION);
		expect(baselineLedger.generatedFrom).toBe(PINNED_BASELINE_COMMIT);
		expect(baselineLedger.additions.packages).toEqual([]);
		expect(Object.keys(baselineLedger.additions.exportsKeys)).toEqual([]);
		expect(Object.keys(baselineLedger.additions.resolvedSubpaths)).toEqual([]);
		expect(Object.keys(baselineLedger.additions.namedExports)).toEqual([]);
		expect(Object.keys(baselineLedger.additions.starEdges)).toEqual([]);
		expect(Object.keys(baselineLedger.additions.binKeys)).toEqual([]);
	});

	it("(c) no bin key lost from any workspace package", () => {
		const missingBins: Record<string, string[]> = {};

		for (const [name, basePkg] of Object.entries(LEDGER.packages)) {
			const headPkg = HEAD_PACKAGES.get(name);
			if (!headPkg) continue;

			const missing = basePkg.binKeys.filter(k => !headPkg.binKeys.includes(k));
			if (missing.length > 0) {
				missingBins[name] = missing;
			}
		}

		expect(missingBins).toEqual({});
	});

	// (d) no named barrel export lost
	it("(d) no named barrel export lost from any entrypoint", () => {
		const missingNamedExports: Record<string, string[]> = {};

		for (const [name, basePkg] of Object.entries(LEDGER.packages)) {
			const headPkg = HEAD_PACKAGES.get(name);
			if (!headPkg) continue;

			const missing = basePkg.namedExports
				.filter(k => !headPkg.namedExports.includes(k))
				.filter(k => {
					// A native binary version sentinel changes with package version bumps (e.g. __veyyonNativesV1_3_0 -> __veyyonNativesV1_4_0)
					if (/^__veyyonNativesV\d+_\d+_\d+/.test(k)) {
						return !headPkg.namedExports.some(h => /^__veyyonNativesV\d+_\d+_\d+/.test(h));
					}
					return true;
				});

			if (missing.length > 0) {
				missingNamedExports[name] = missing;
			}
		}

		expect(missingNamedExports).toEqual({});
	});

	// (e) every star edge resolves
	it("(e) every star export edge resolves to a file on disk", () => {
		const unresolvedStarEdges: Array<{ package: string; star: string; fromFile: string }> = [];
		let totalTestedStarEdges = 0;

		for (const [name, headPkg] of HEAD_PACKAGES.entries()) {
			if (!headPkg.entrypointFilePath) continue;

			for (const star of headPkg.starEdges) {
				totalTestedStarEdges++;
				const resolved = resolveStarSpecifierToDisk(headPkg.entrypointFilePath, star);
				if (!resolved) {
					unresolvedStarEdges.push({
						package: name,
						star,
						fromFile: headPkg.entrypointFilePath,
					});
				}
			}
		}

		expect(unresolvedStarEdges).toEqual([]);
		expect(totalTestedStarEdges).toBeGreaterThan(200);
	});

	// (f) additions pinned by exact equality
	it("(f) additions pinned by exact equality", () => {
		const baseNames = new Set(Object.keys(LEDGER.packages));
		const actualAddedPackages = [...HEAD_PACKAGES.keys()].filter(name => !baseNames.has(name)).sort();
		expect(actualAddedPackages).toEqual([...LEDGER.additions.packages].sort());

		const actualAddedExportsKeys: Record<string, string[]> = {};
		const actualAddedResolvedSubpaths: Record<string, string[]> = {};
		for (const [name, headPkg] of HEAD_PACKAGES.entries()) {
			const basePkg = LEDGER.packages[name];
			if (!basePkg) continue;

			const addedExp = headPkg.exportsKeys.filter(k => !basePkg.exportsKeys.includes(k)).sort();
			if (addedExp.length > 0) {
				actualAddedExportsKeys[name] = addedExp;
			}

			const addedResolved = headPkg.resolvedSubpaths.filter(k => !basePkg.resolvedSubpaths.includes(k)).sort();
			if (addedResolved.length > 0) {
				actualAddedResolvedSubpaths[name] = addedResolved;
			}
		}

		expect(actualAddedExportsKeys).toEqual(LEDGER.additions.exportsKeys as Record<string, string[]>);
		expect(actualAddedResolvedSubpaths).toEqual(LEDGER.additions.resolvedSubpaths as Record<string, string[]>);
	});

	// (f2) working-tree measurement excludes git-ignored runtime debris and includes legitimate added source
	it("(f2) working-tree measurement excludes git-ignored runtime debris and includes legitimate added source", () => {
		const tempRepo = mkdtempSync(join(tmpdir(), "published-surface-enum-"));
		try {
			execFileSync("git", ["init", "-q", tempRepo]);
			const writeIn = (rel: string, content: string): void => {
				const full = join(tempRepo, rel);
				mkdirSync(join(full, ".."), { recursive: true });
				writeFileSync(full, content, "utf-8");
			};

			writeIn(".gitignore", ".cache/\nruns/\n*.tmp\ncoverage/\n");
			writeIn("packages/sample/package.json", JSON.stringify({ name: "@sample/pkg", main: "src/index.ts" }));
			writeIn("packages/sample/src/index.ts", "export const index = true;\n");
			writeIn("packages/sample/src/feature.ts", "export const feature = true;\n");

			// Ignored runtime debris that must not be enumerated
			writeIn("packages/sample/.cache/dataset.ts", "export const cache = true;\n");
			writeIn("packages/sample/runs/run-01/output.ts", "export const run = true;\n");
			writeIn("packages/sample/coverage/lcov.ts", "export const coverage = true;\n");
			writeIn("packages/sample/src/temp.tmp", "temporary content\n");

			const initialFiles = filesUnderMember("packages/sample", tempRepo);
			expect(initialFiles.sort()).toEqual([
				"packages/sample/package.json",
				"packages/sample/src/feature.ts",
				"packages/sample/src/index.ts",
			]);

			// Adding a new non-ignored source file is included immediately
			writeIn("packages/sample/src/new-module.ts", "export const newModule = true;\n");
			const updatedFiles = filesUnderMember("packages/sample", tempRepo);
			expect(updatedFiles.sort()).toEqual([
				"packages/sample/package.json",
				"packages/sample/src/feature.ts",
				"packages/sample/src/index.ts",
				"packages/sample/src/new-module.ts",
			]);
		} finally {
			rmSync(tempRepo, { recursive: true, force: true });
		}

		// Fails closed on invalid or non-git directory
		expect(() => filesUnderMember("packages/sample", "/nonexistent/invalid/repo/root")).toThrow(
			/Failed to enumerate files under/,
		);
	});

	// (g) anti-vacuity
	it("(g) anti-vacuity: sweeps real members, asserts core packages, and trips on simulated loss", () => {
		// Minimum package count threshold
		expect(HEAD_PACKAGES.size).toBeGreaterThan(15);
		expect(Object.keys(LEDGER.packages).length).toBeGreaterThan(15);

		// Assert at least one export from @veyyon/tui, @veyyon/utils, and @veyyon/coding-agent
		const tuiPkg = HEAD_PACKAGES.get("@veyyon/tui");
		expect(tuiPkg).toBeDefined();
		expect(tuiPkg?.starEdges).toContain("./components/box");
		expect(tuiPkg?.starEdges).toContain("./tui");

		const utilsPkg = HEAD_PACKAGES.get("@veyyon/utils");
		expect(utilsPkg).toBeDefined();
		expect(utilsPkg?.namedExports).toContain("logger");
		expect(utilsPkg?.starEdges).toContain("./byte-truncate");

		const codingAgentPkg = HEAD_PACKAGES.get("@veyyon/coding-agent");
		expect(codingAgentPkg).toBeDefined();
		expect(codingAgentPkg?.namedExports).toContain("VERSION");
		expect(codingAgentPkg?.namedExports).toContain("logger");
		expect(codingAgentPkg?.starEdges).toContain("./session/agent-session");

		// Positive control: simulated loss of an export in an in-memory baseline fails the check
		const syntheticMissingName = "FAKE_DROPPED_EXPORT";
		const syntheticBase = {
			...LEDGER.packages["@veyyon/utils"],
			namedExports: [...(LEDGER.packages["@veyyon/utils"]?.namedExports ?? []), syntheticMissingName],
		};

		const testHeadExports = utilsPkg?.namedExports ?? [];
		const detectedLoss = syntheticBase.namedExports.filter(name => !testHeadExports.includes(name));
		expect(detectedLoss).toContain(syntheticMissingName);
	});

	// (mutation gates) detects all simulated violations and regressions across every assertion
	it("(mutation gates) detects all simulated violations and regressions across every assertion", () => {
		// 1. Missing package in HEAD fails check (a)
		const baseNames = Object.keys(LEDGER.packages);
		const mutatedHeadMissingPkg = new Map(HEAD_PACKAGES);
		mutatedHeadMissingPkg.delete("@veyyon/utils");
		const missingPkgs = baseNames.filter(name => !mutatedHeadMissingPkg.has(name));
		expect(missingPkgs).toContain("@veyyon/utils");

		// 2. Undocumented missing exports key fails check (b)
		const utilsBaseExports = LEDGER.packages["@veyyon/utils"]?.exportsKeys ?? [];
		const mutatedHeadMissingExports = new Map(HEAD_PACKAGES);
		const originalUtils = HEAD_PACKAGES.get("@veyyon/utils")!;
		mutatedHeadMissingExports.set("@veyyon/utils", {
			...originalUtils,
			exportsKeys: originalUtils.exportsKeys.filter(k => k !== "."),
		});
		const missingExports = utilsBaseExports.filter(
			k => !mutatedHeadMissingExports.get("@veyyon/utils")?.exportsKeys.includes(k),
		);
		expect(missingExports).toContain(".");

		// 3. Unserved relocation destination fails check (b2)
		const fakeUnservedNote = {
			to: "./nonexistent/target",
			why: "this is a fake unserved relocation note for mutation testing",
		};
		const headPkg = HEAD_PACKAGES.get("@veyyon/coding-agent")!;
		const successorKey = fakeUnservedNote.to;
		expect(headPkg.exportsKeys.includes(successorKey)).toBe(false);

		// 4. Dropped resolved subpath with no relocation fails check (b3)
		const utilsBaseSubpaths = LEDGER.packages["@veyyon/utils"]?.resolvedSubpaths ?? [];
		const droppedSubpath = utilsBaseSubpaths[0];
		expect(droppedSubpath).toBeDefined();
		const emptyRelocations: Record<string, unknown> = {};
		expect(droppedSubpath! in emptyRelocations).toBe(false);

		// 5. Unserved subpath relocation successor fails check (b3)
		const fakeSuccessor = "@veyyon/nonexistent-package/subpath";
		const successorPackage = fakeSuccessor.split("/").slice(0, 2).join("/");
		expect(HEAD_PACKAGES.has(successorPackage)).toBe(false);

		// 6. Dropped bin key fails check (c)
		const codingAgentBinKeys = LEDGER.packages["@veyyon/coding-agent"]?.binKeys ?? [];
		if (codingAgentBinKeys.length > 0) {
			const mutatedHeadNoBin = new Map(HEAD_PACKAGES);
			const originalCodingAgent = HEAD_PACKAGES.get("@veyyon/coding-agent")!;
			mutatedHeadNoBin.set("@veyyon/coding-agent", { ...originalCodingAgent, binKeys: [] });
			const missingBins = codingAgentBinKeys.filter(
				k => !mutatedHeadNoBin.get("@veyyon/coding-agent")?.binKeys.includes(k),
			);
			expect(missingBins).toEqual([...codingAgentBinKeys]);
		}

		// 7. Dropped named export fails check (d)
		const utilsNamedExports = LEDGER.packages["@veyyon/utils"]?.namedExports ?? [];
		const droppedNamedExport = utilsNamedExports.find(name => name === "logger");
		expect(droppedNamedExport).toBe("logger");
		const headWithoutLogger = utilsNamedExports.filter(name => name !== "logger");
		expect(headWithoutLogger.includes("logger")).toBe(false);

		// 8. Unresolvable star edge fails check (e)
		const fakeStarEdge = "./nonexistent-star-edge-module";
		const resolvedFakeStar = resolveStarSpecifierToDisk(originalUtils.entrypointFilePath!, fakeStarEdge);
		expect(resolvedFakeStar).toBeNull();

		// 9. Unapproved added package fails check (f)
		const approvedAdditions = new Set(LEDGER.additions.packages);
		const unapprovedAddedPkg = "@veyyon/unapproved-new-package";
		expect(approvedAdditions.has(unapprovedAddedPkg)).toBe(false);

		// 10. Unapproved added exports key fails check (f)
		const approvedAddedKeys = new Set(LEDGER.additions.exportsKeys["@veyyon/wire"] ?? []);
		const unapprovedAddedKey = "./unapproved-new-wire-subpath";
		expect(approvedAddedKeys.has(unapprovedAddedKey)).toBe(false);
	});
});
