/**
 * q→query / operation→op are table entries schema-repair.test.ts never names.
 * Overwrite and two-source refusals are already pinned there for filepath;
 * this file only pins the q/Query spelling trap.
 */
import { describe, expect, it } from "bun:test";
import { planAliasKeyRepairs } from "@veyyon/coding-agent/repair/schema-repair";

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
	return { type: "object", properties };
}

describe("q aliases onto a declared query field, not Query", () => {
	it("renames q to query when query is declared and absent", () => {
		const plan = planAliasKeyRepairs(objectSchema({ query: { type: "string" } }), { q: "needle" });
		expect(plan).toEqual({ kind: "renamed", renames: new Map([["q", "query"]]) });
	});

	it("does not apply q→query when the schema only declared Query (alias targets are exact, not folded)", () => {
		const plan = planAliasKeyRepairs(objectSchema({ Query: { type: "string" } }), { q: "needle" });
		expect(plan).toEqual({ kind: "none" });
	});

	it("still applies the literal alias q→query when query is declared alongside Query", () => {
		const schema = objectSchema({
			query: { type: "string" },
			Query: { type: "string" },
		});
		expect(planAliasKeyRepairs(schema, { q: "needle" })).toEqual({
			kind: "renamed",
			renames: new Map([["q", "query"]]),
		});
	});
});
