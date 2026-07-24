/**
 * ONE-PLACE lock for the read-tool selector splitter.
 *
 * The selector grammar (`:50-200`, `:raw`, `:conflicts`, compounds) was once
 * hand-duplicated in three spots: the read tool's `splitPathAndSel`
 * (coding-agent) and compaction's `splitReadSelector` (agent-core), each with a
 * local copy of the grammar and a "keep in sync" comment, plus the shared owner
 * they were consolidated into (`@veyyon/utils`). If they ever diverged,
 * compaction would compute a file-operation dedup key on a different base path
 * than the read tool actually opened, silently breaking supersede-prune.
 *
 * These assertions make divergence impossible to reintroduce quietly: the three
 * exported symbols must be the SAME function reference. A future edit that
 * reintroduces a local reimplementation in either package breaks referential
 * identity here and fails the suite. A behavioral spot-check backs it up so the
 * one shared function still splits the way both call sites expect.
 */
import { describe, expect, it } from "bun:test";
import { splitReadSelector as compactionSplitReadSelector } from "@veyyon/agent-core/compaction/utils";
import { splitReadSelector as utilsSplitReadSelector } from "@veyyon/utils";
import { splitPathAndSel } from "../../src/tools/path-utils";

describe("read-tool selector splitter has exactly one owner", () => {
	it("the read tool's splitPathAndSel IS the @veyyon/utils owner (same reference)", () => {
		expect(splitPathAndSel).toBe(utilsSplitReadSelector);
	});

	it("compaction's splitReadSelector IS the same @veyyon/utils owner (same reference)", () => {
		expect(compactionSplitReadSelector).toBe(utilsSplitReadSelector);
	});

	it("all three call sites resolve to one function, so the grammar cannot drift", () => {
		expect(splitPathAndSel).toBe(compactionSplitReadSelector);
	});

	it("still splits the shapes both call sites depend on", () => {
		expect(splitPathAndSel("src/main.ts:50-200")).toEqual({ path: "src/main.ts", sel: "50-200" });
		expect(splitPathAndSel("src/main.ts:raw:1-50")).toEqual({ path: "src/main.ts", sel: "raw:1-50" });
		expect(splitPathAndSel("C:\\src\\main.ts")).toEqual({ path: "C:\\src\\main.ts" });
		expect(splitPathAndSel("conflict://1")).toEqual({ path: "conflict://1" });
	});
});
