/**
 * WHY: the string, escape, keyboard and layout primitives moved out of
 * `@veyyon/tui` into `@veyyon/utils` so that measuring a width, wrapping a line
 * or parsing a key no longer requires a terminal. That direction is only real
 * while the dependency stays one-way. One `@veyyon/tui` import in utils restores
 * the cycle the move existed to remove, and every consumer of a utility — an
 * export pipeline, a browser client, a bench — pulls the renderer back in.
 *
 * The defect class is a single convenience import: a `Component` type for a
 * signature, a `TERMINAL` capability read instead of a pushed value. The
 * capability seam already exists for exactly that case
 * (`@veyyon/utils/color-format` is told the encoding rather than probing it),
 * so a new one is a design decision, not a shortcut.
 *
 * What it does NOT catch: a utility that duplicates a tui behaviour instead of
 * importing it.
 */

import { describe, expect, test } from "bun:test";
import { forbiddenEdges, isDirectory, repoPath, typeScriptFiles } from "./helpers/module-graph";

const UTILS = repoPath("packages/utils/src");

function isTuiImport(specifier: string): boolean {
	return specifier === "@veyyon/tui" || specifier.startsWith("@veyyon/tui/");
}

describe("the utilities do not depend on the renderer", () => {
	test("the directory exists and holds a substantial number of modules", () => {
		expect(isDirectory(UTILS)).toBe(true);
		// The move brought around twenty modules over; a sweep that finds a handful
		// is looking at the wrong tree.
		expect(typeScriptFiles(UTILS).length).toBeGreaterThan(30);
	});

	test("no file imports @veyyon/tui", () => {
		expect(forbiddenEdges(UTILS, isTuiImport)).toEqual([]);
	});

	test("no file reaches the tui package by relative path", () => {
		expect(forbiddenEdges(UTILS, specifier => specifier.includes("../tui/"))).toEqual([]);
	});
});
