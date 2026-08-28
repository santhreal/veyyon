/**
 * WHY: `@veyyon/wire/presentation` is the contract a terminal driver and a
 * browser client both implement. The moment one file in it imports
 * `@veyyon/tui`, every consumer of the contract drags a terminal renderer in,
 * and the browser client cannot build. The defect class is a convenience import
 * added for one type — a `Component`, an `OverlayAnchor`, a colour helper — that
 * nobody notices until a non-terminal consumer breaks.
 *
 * The assertion is over the module graph: a directory sweep of the declared
 * specifiers, so a new file in the directory is covered without being listed.
 *
 * What it does NOT catch: a tui type re-declared by hand in wire, which is a
 * duplication problem rather than a dependency one.
 */

import { describe, expect, test } from "bun:test";
import { forbiddenEdges, importSpecifiers, isDirectory, repoPath, typeScriptFiles } from "./helpers/module-graph";

const PRESENTATION = repoPath("packages/wire/src/presentation");

/** Renderer packages the contract must never reach for. */
const RENDERERS = ["@veyyon/tui", "@veyyon/natives", "@veyyon/tool-render", "@veyyon/collab-web"];

function isRendererImport(specifier: string): boolean {
	return RENDERERS.some(renderer => specifier === renderer || specifier.startsWith(`${renderer}/`));
}

describe("the presentation contract does not depend on a renderer", () => {
	test("the directory exists and holds modules to check", () => {
		// A sweep over an absent or empty directory passes vacuously, which is the
		// one way this suite could go green while the contract is gone.
		expect(isDirectory(PRESENTATION)).toBe(true);
		expect(typeScriptFiles(PRESENTATION).length).toBeGreaterThan(4);
	});

	test("no file imports a renderer package", () => {
		expect(forbiddenEdges(PRESENTATION, isRendererImport)).toEqual([]);
	});

	test("every specifier is a relative sibling or a dependency-free package", () => {
		// The contract's whole value is that it depends on nothing in this repo. A
		// specifier that is neither relative nor a node builtin is the edge to check.
		const external: string[] = [];
		for (const file of typeScriptFiles(PRESENTATION)) {
			for (const specifier of importSpecifiers(file)) {
				if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
				external.push(specifier);
			}
		}
		expect([...new Set(external)].sort()).toEqual([]);
	});
});
