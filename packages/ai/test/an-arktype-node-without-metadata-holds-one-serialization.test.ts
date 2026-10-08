/**
 * An ArkType node without metadata holds one serialization of itself.
 *
 * WHY THIS SUITE EXISTS. ArkType 0.56 serialized every node it constructed twice: `innerJson` and
 * `innerHash` without the node's metadata, then `json` and `hash` with it. A node without metadata,
 * which is nearly every node a tool or settings schema builds, got two equal objects and two equal
 * strings, and each string is the JSON of the node's whole subtree. A launch held about 950 of these
 * duplicate hash strings, 270 KiB of heap and string storage. `patches/@ark%2Fschema@0.56.2.patch`
 * hands a node without metadata its inner object and string as `json` and `hash`, so it serializes
 * once and holds one copy.
 *
 * The class it closes: a second serialization held by a node that has no metadata to add to it. The
 * census reads a heap snapshot and counts, over every node a broad schema build adds, the nodes whose
 * `hash` and `innerHash` are two string cells and whose `json` and `innerJson` are two values. Both
 * counts are pinned at zero, so an ArkType upgrade that drops the patch turns this red. The nodes that
 * do carry metadata still serialize it into `hash` and `json` and not into the inner pair, the
 * `json` a caller reads is pinned for each case, and a second parse still returns the cached node,
 * which is keyed by `hash`.
 *
 * WHAT IT DOES NOT CATCH: a copy of a serialization held somewhere other than a node's own `hash`,
 * `innerHash`, `json` and `innerJson`, and the size of the single serialization each node keeps.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { NodeSerializationReport } from "./fixtures/arktype-node-serializations";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "arktype-node-serializations.ts");

function jitlessReport(): NodeSerializationReport {
	const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`node serialization fixture exited ${run.status}: ${run.stderr}`);
	return JSON.parse(run.stdout) as NodeSerializationReport;
}

describe("an ArkType node without metadata holds one serialization", () => {
	const report = jitlessReport();

	it("holds hash and innerHash as one string and json and innerJson as one value", () => {
		const { census } = report;
		expect(census.withoutMeta).toBeGreaterThan(200);
		expect(census.withoutMetaTwoHashCells).toBe(0);
		expect(census.withoutMetaTwoJsonValues).toBe(0);
	});

	it("serializes the metadata of a node that carries it into hash and json only", () => {
		const { census } = report;
		// The described object, its two described values and the object's domain.
		expect(census.withMeta).toBeGreaterThanOrEqual(4);
		expect(census.withMetaHashCarriesMeta).toBe(census.withMeta);
		expect(census.withMetaJsonCarriesMeta).toBe(census.withMeta);
	});

	it("reports the json a caller reads for nodes with and without metadata", () => {
		const { key } = report;
		expect(report.json).toEqual([
			{ required: [{ key, value: "string" }], optional: [{ key: `${key}_n`, value: "number" }], domain: "object" },
			{ domain: "string", meta: `text ${key}` },
			{
				required: [{ key, value: { domain: "number", meta: `count ${key}` } }],
				domain: { domain: "object", meta: `outer ${key}` },
				meta: `outer ${key}`,
			},
		]);
	});

	it("returns the cached node for a second parse and keeps a described node apart", () => {
		expect(report.reparseReturnsCachedNode).toEqual([true, true, true]);
		expect(report.describedIsDistinct).toBe(true);
	});
});
