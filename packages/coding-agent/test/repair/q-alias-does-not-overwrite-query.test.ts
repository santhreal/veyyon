/**
 * Alias repair is fix-if-clear, refuse-if-ambiguous, and the alias table is
 * an exact declared-name lookup, not a normalized one.
 *
 * WHY THIS SUITE EXISTS. schema-repair.test.ts pins filepath→path and the
 * two-unknown-keys-one-target refusal. It never mentions `q`→`query` or
 * `operation`→`op`, which were added later because todo/goal/search models
 * write the short name and the tool then answers that the field was missing.
 * It also never pins the case where two declared properties normalize to the
 * same spelling (`query` and `Query`): matching against that form is skipped
 * so the harness does not guess, but the COMMON_KEY_ALIASES table still
 * looks up the *literal* target `"query"` with `declaredSet.has`.
 *
 * A model sending `{ q: "foo" }` against a schema that only declared
 * `Query` must not be rewritten onto a field that does not exist.
 */
import { describe, expect, it } from "bun:test";
import { planAliasKeyRepairs } from "@veyyon/coding-agent/repair/schema-repair";

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
	return { type: "object", properties };
}

describe("q / searchquery alias onto a declared query field", () => {
	const schema = objectSchema({ query: { type: "string" }, path: { type: "string" } });

	it("renames q to query when query is declared and absent", () => {
		const plan = planAliasKeyRepairs(schema, { q: "needle", path: "." });
		expect(plan).toEqual({ kind: "renamed", renames: new Map([["q", "query"]]) });
	});

	it("renames searchquery to query the same way", () => {
		const plan = planAliasKeyRepairs(schema, { searchquery: "needle" });
		expect(plan).toEqual({ kind: "renamed", renames: new Map([["searchquery", "query"]]) });
	});

	it("renames search_query / search-query after separator stripping", () => {
		expect(planAliasKeyRepairs(schema, { search_query: "needle" })).toEqual({
			kind: "renamed",
			renames: new Map([["search_query", "query"]]),
		});
		expect(planAliasKeyRepairs(schema, { "search-query": "needle" })).toEqual({
			kind: "renamed",
			renames: new Map([["search-query", "query"]]),
		});
	});

	it("refuses q when query is already present (no silent overwrite)", () => {
		const plan = planAliasKeyRepairs(schema, { q: "from-q", query: "from-query" });
		expect(plan.kind).toBe("ambiguous");
		if (plan.kind !== "ambiguous") return;
		expect(plan.reason).toMatch(/already present/);
		expect(plan.reason).toContain('"q"');
		expect(plan.reason).toContain('"query"');
	});

	it("refuses q and searchquery together (two sources, one target)", () => {
		const plan = planAliasKeyRepairs(schema, { q: "a", searchquery: "b" });
		expect(plan.kind).toBe("ambiguous");
		if (plan.kind !== "ambiguous") return;
		expect(plan.reason).toMatch(/all look like aliases for "query"/);
	});

	it("does not rename q when the schema never declared query", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), { q: "needle", path: "." });
		expect(plan).toEqual({ kind: "none" });
	});
});

describe("operation / action alias onto a declared op field", () => {
	const schema = objectSchema({ op: { type: "string" }, id: { type: "string" } });

	it("renames operation to op", () => {
		expect(planAliasKeyRepairs(schema, { operation: "complete", id: "1" })).toEqual({
			kind: "renamed",
			renames: new Map([["operation", "op"]]),
		});
	});

	it("renames action to op", () => {
		expect(planAliasKeyRepairs(schema, { action: "drop" })).toEqual({
			kind: "renamed",
			renames: new Map([["action", "op"]]),
		});
	});

	it("refuses operation when op is already set", () => {
		const plan = planAliasKeyRepairs(schema, { operation: "complete", op: "drop" });
		expect(plan.kind).toBe("ambiguous");
	});
});

describe("declared properties that collide after normalization", () => {
	it("does not guess among query and Query; a QUERY typo is left untouched", () => {
		const schema = objectSchema({
			query: { type: "string" },
			Query: { type: "string" },
		});
		const plan = planAliasKeyRepairs(schema, { QUERY: "needle" });
		// Normalized form `query` collided across two declared keys, so it is
		// removed from the lookup table. QUERY therefore has no unique target.
		expect(plan).toEqual({ kind: "none" });
	});

	it("still applies the literal alias q→query when query (exact spelling) is declared alongside Query", () => {
		const schema = objectSchema({
			query: { type: "string" },
			Query: { type: "string" },
		});
		const plan = planAliasKeyRepairs(schema, { q: "needle" });
		expect(plan).toEqual({ kind: "renamed", renames: new Map([["q", "query"]]) });
	});

	it("does not apply q→query when the schema only declared Query (alias targets are exact, not folded)", () => {
		const schema = objectSchema({ Query: { type: "string" } });
		const plan = planAliasKeyRepairs(schema, { q: "needle" });
		expect(plan).toEqual({ kind: "none" });
	});

	it("ignores __-prefixed repair sentinels so they cannot alias onto query", () => {
		const schema = objectSchema({ query: { type: "string" } });
		const plan = planAliasKeyRepairs(schema, { __q: "needle", query: "keep" });
		expect(plan).toEqual({ kind: "none" });
	});

	it("returns none for a non-object schema rather than walking properties", () => {
		const plan = planAliasKeyRepairs({ type: "string" }, { q: "needle" });
		expect(plan).toEqual({ kind: "none" });
	});
});
