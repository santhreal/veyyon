/**
 * WHY THIS SUITE EXISTS. A publishable member's `exports` map is its public API, and the names
 * behind each entry point reach consumers through star re-export chains several hops deep. A move
 * that leaves a barrel behind, a helper extraction with no re-export, or a dead-code sweep that
 * un-exported a name still imported elsewhere shrinks that surface without touching the line a
 * reader would look at. The failure then lands in whatever project imported the name, which may be
 * outside this repository, and it lands at that project's next type check rather than in this diff.
 *
 * WHAT THIS CLOSES. The class is "a value that was importable from a published specifier is no
 * longer importable from it" — for every publishable member, and for every entry point each member
 * declares, not only the package root. The gate imports each declared specifier and compares the
 * value names against a committed baseline: a name that vanished is red, a name that appeared is
 * allowed, since the baseline is a floor. Adding a member, or an entry point, with no baseline row
 * is red too, so a new surface is a recorded decision instead of an unswept one.
 *
 * WHAT IT DOES NOT CATCH. Three gaps, each stated rather than hidden:
 *
 *  - Type-only exports. `export type { Foo }` leaves nothing for `Object.keys` at run time, so a
 *    removed type passes here. The type check and the type tests are what cover that.
 *  - Wildcard entry points (`./tools/*`). The set a wildcard resolves to is the file tree, and this
 *    branch moves that tree constantly; a baseline of it would be a second copy of the layout. A
 *    member reached only through wildcards has no row here, and the suite pins that set by exact
 *    equality so a member joining it is a decision.
 *  - A specifier no server runtime can import, which is pinned with its reason in
 *    `SPECIFIERS_A_SERVER_RUNTIME_CANNOT_IMPORT`.
 *
 * HOW TO UPDATE. Add a public export, run this suite, and it names the specifier whose floor moved:
 *
 *   bun run scripts/gen-package-exports-baseline.ts
 *
 * Commit the regenerated baseline with the change that moved the surface.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expandExportFloor } from "./package-export-floor";
import {
	exportedNames,
	publishableMembers,
	SPECIFIERS_A_SERVER_RUNTIME_CANNOT_IMPORT,
} from "./package-exports-surface";
import { REPO_ROOT } from "./workspace-layout";

const baseline = expandExportFloor(
	JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "package-exports-baseline.json"), "utf8")),
);

const members = publishableMembers();

/**
 * Publishable members that declare no fixed entry point this gate can sweep.
 *
 * `@veyyon/kernel` publishes only wildcard subpaths (`./session/*`, `./loader/*`, `./registry/*`),
 * so it has no module a consumer imports by a name written in the manifest. `@veyyon/swarm-extension`
 * declares no `exports` map at all and is loaded as an extension rather than imported. Pinned by
 * exact equality: a member that stops publishing a fixed entry point turns this red.
 */
const MEMBERS_WITHOUT_A_SWEPT_ENTRY_POINT = ["@veyyon/kernel", "@veyyon/swarm-extension"];

describe("a package exports its public surface", () => {
	it("sweeps every publishable member that declares an entry point", () => {
		const empty = members.filter(member => member.specifiers.length === 0).map(member => member.name);
		expect(empty).toEqual(MEMBERS_WITHOUT_A_SWEPT_ENTRY_POINT);
		// Anti-vacuity: the sweep is the rest of them, and it is not one package's root.
		const swept = members.filter(member => member.specifiers.length > 0);
		expect(swept.length).toBeGreaterThan(MEMBERS_WITHOUT_A_SWEPT_ENTRY_POINT.length);
		expect(swept.flatMap(member => member.specifiers).length).toBeGreaterThan(swept.length);
	});

	it("holds a baseline row for every specifier it sweeps, and sweeps every row it holds", () => {
		const swept = members.flatMap(member => member.specifiers).sort();
		// Both directions: a new entry point with no floor is as much a hole as a floor whose entry
		// point was deleted and left behind in the baseline.
		expect(swept.filter(specifier => baseline[specifier] === undefined)).toEqual([]);
		expect(Object.keys(baseline).filter(specifier => !swept.includes(specifier))).toEqual([]);
	});

	it("names the reason for every specifier it cannot import", () => {
		for (const [specifier, reason] of Object.entries(SPECIFIERS_A_SERVER_RUNTIME_CANNOT_IMPORT)) {
			expect(reason.length).toBeGreaterThan(20);
			expect(baseline[specifier]).toBeUndefined();
		}
	});

	for (const member of members) {
		for (const specifier of member.specifiers) {
			it(`${specifier} still exports every name in its baseline`, async () => {
				const exported = new Set(await exportedNames(specifier));
				const missing = (baseline[specifier] ?? []).filter(name => !exported.has(name));
				expect(missing).toEqual([]);
			});
		}
	}
});
