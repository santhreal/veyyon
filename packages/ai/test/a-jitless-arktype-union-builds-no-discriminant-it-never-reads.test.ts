/**
 * A jitless ArkType union builds no discriminant it never reads.
 *
 * WHY THIS SUITE EXISTS. ArkType 0.56 builds a discriminant for every union node at construction: it
 * intersects each pair of branches to find a key whose value tells them apart, then serializes the
 * result. Only compiled traversal reads it. The CLI configures ArkType jitless, where a union walks its
 * branches in order, so every discriminant a launch built was CPU spent before the first frame and an
 * object held for the life of the process. `patches/@ark%2Fschema@0.56.2.patch` builds the
 * discriminant on first read in a jitless scope; in a compiling scope it still builds it at
 * construction, because building it adds the case nodes to the node's references, which a parent
 * copies when it is constructed and the precompiler binds. The serialized form is built on first read
 * in either mode.
 *
 * The class it closes: a discriminant built for a union that no compiled traversal reads. In a jitless
 * process, as the CLI runs, no union a build registered holds either member after its values were
 * validated, and a read returns the discriminant a compiling scope builds. In this compiling process
 * every union holds its discriminant and none holds the serialized form. Every outcome in either mode
 * is pinned verbatim, so a validation the patch changed turns this red. A union a jitless scope holds,
 * compiled by a compiling scope that references it, validates and reports what jitless traversal
 * reports, rather than calling a case node the precompiler never bound.
 *
 * WHAT IT DOES NOT CATCH: a union node a scope builds without registering it, such as one a scope
 * rebinds from another, which the census does not count; and per-union work at construction other
 * than the discriminant.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { reportUnionDiscriminants, type UnionDiscriminantReport } from "./fixtures/arktype-union-discriminants";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "arktype-union-discriminants-jitless.ts");

function jitlessReport(): UnionDiscriminantReport {
	const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`union discriminant fixture exited ${run.status}: ${run.stderr}`);
	return JSON.parse(run.stdout) as UnionDiscriminantReport;
}

const TAGGED_DISCRIMINANT = {
	kind: "unit",
	path: ["kind"],
	cases: {
		'"a_<salt>"': { required: [{ key: "x", value: "number" }] },
		'"b_<salt>"': { required: [{ key: "y", value: "string" }] },
		'"c_<salt>"': { required: [{ key: "z", value: [{ unit: false }, { unit: true }] }] },
	},
};

/** A union a jitless scope holds reports this in either mode, compiled or walked. */
const JITLESS_HELD_UNION_OUTCOMES = [
	'accepts: {"inner":{"wrap_<salt>":{"kind":"q_<salt>","s":"ok"}},"count":1}',
	'rejects: inner.wrap_<salt>.n must be a number (was a string) or inner.wrap_<salt>.kind must be "q_<salt>" (was "p_<salt>")',
	'rejects: inner.wrap_<salt>.kind must be "p_<salt>" or "q_<salt>" (was "r_<salt>")',
];

describe("a jitless ArkType union builds no discriminant it never reads", () => {
	const jitless = jitlessReport();
	const compiling = reportUnionDiscriminants(`c${Date.now().toString(36)}`);

	it("leaves every union a jitless build registered without a discriminant after validating with it", () => {
		expect(jitless.unions).toBe(7);
		expect(jitless.ownAfterBuild).toEqual({ discriminant: 0, discriminantJson: 0 });
	});

	it("builds the discriminant a compiling scope builds when a jitless union is read", () => {
		expect(jitless.taggedDiscriminant).toEqual(TAGGED_DISCRIMINANT);
		expect(jitless.ownAfterRead).toEqual(["discriminant", "discriminantJson"]);
	});

	it("validates in a jitless process as ArkType walks a union's branches", () => {
		expect(jitless.outcomes).toEqual([
			'accepts: {"kind":"a_<salt>","x":1}',
			'rejects: kind must be "a_<salt>" or "c_<salt>" (was "b_<salt>") or y must be a string (was a number)',
			'rejects: kind must be "a_<salt>", "b_<salt>" or "c_<salt>" (was "d_<salt>")',
			'accepts: "x_<salt>"',
			'rejects: must be "x_<salt>", "y_<salt>" or 3 (was 4)',
			'accepts: {"v_<salt>":[1,2]}',
			"rejects: v_<salt> must be a string, an array, false or true (was null)",
			...JITLESS_HELD_UNION_OUTCOMES,
		]);
	});

	it("builds every compiling union's discriminant with the node and its serialized form on first read", () => {
		// The case nodes building the tagged and the domain discriminant add are unions too.
		expect(compiling.unions).toBe(8);
		expect(compiling.ownAfterBuild).toEqual({ discriminant: 8, discriminantJson: 0 });
		expect(compiling.taggedDiscriminant).toEqual(TAGGED_DISCRIMINANT);
		expect(compiling.ownAfterRead).toEqual(["discriminant", "discriminantJson"]);
	});

	it("validates in a compiling process through the discriminant, and walks a union a jitless scope holds", () => {
		expect(compiling.outcomes).toEqual([
			'accepts: {"kind":"a_<salt>","x":1}',
			"rejects: y must be a string (was a number)",
			'rejects: kind must be "a_<salt>", "b_<salt>" or "c_<salt>" (was "d_<salt>")',
			'accepts: "x_<salt>"',
			'rejects: must be 3, "x_<salt>" or "y_<salt>" (was 4)',
			'accepts: {"v_<salt>":[1,2]}',
			"rejects: v_<salt> must be a string, an object or boolean (was null)",
			...JITLESS_HELD_UNION_OUTCOMES,
		]);
	});
});
