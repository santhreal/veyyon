/**
 * pathToQuery maps `/foo/bar/0` to `.foo.bar[0]`. Empty segments are dropped,
 * non-identifiers use `['...']`, and decodeURIComponent runs per segment.
 *
 * WHY THIS SUITE EXISTS. json-query.test.ts pins `/foo/bar/0`, trailing slash,
 * `['a b']`, and `/%2Ffoo`. The leftover suite pins `['a\'b']` with no leading
 * dot. Neither pins:
 *
 *   - a `.` or `..` path segment (they are identifiers `[A-Za-z0-9_-]`? NO —
 *     they contain only dots, so they MUST go through bracket-quote form,
 *     otherwise applyQuery would walk inherited keys named "" or skip them).
 *   - `+` in a path is NOT space (`decodeURIComponent` does not plus-decode).
 *   - `%2B` is a plus character in the key, distinct from `+`.
 *   - `%2e%2e` decodes to `..` and must still be a quoted key, not a hop.
 *   - a numeric segment with a leading plus (`/+3`) is not `/^\d+$/` after
 *     decode, so it is not `[3]`.
 *
 * applyQuery then has to round-trip those keys. A `.` segment that became
 * an extra skipped dot (parseQuery skips `.`) would silently drop the
 * component and return the parent object — the operator extracts the wrong
 * JSON from agent://.
 */
import { describe, expect, it } from "bun:test";
import { applyQuery, parseQuery, pathToQuery } from "@veyyon/coding-agent/internal-urls/json-query";

describe("dot and dot-dot path segments are keys, not hops", () => {
	it("encodes a '.' segment as a quoted key, not as a skipped parseQuery dot", () => {
		const q = pathToQuery("/foo/./bar");
		expect(q).toBe(".foo['.'].bar");
		expect(parseQuery(q)).toEqual(["foo", ".", "bar"]);
		expect(applyQuery({ foo: { ".": { bar: 1 } } }, q)).toBe(1);
	});

	it("encodes a '..' segment as a quoted key, not as a parent hop", () => {
		const q = pathToQuery("/foo/../secret");
		expect(parseQuery(q)).toEqual(["foo", "..", "secret"]);
		expect(applyQuery({ foo: { "..": { secret: 7 } } }, q)).toBe(7);
		expect(applyQuery({ secret: "no" }, q)).toBeUndefined();
	});

	it("encodes %2e%2e as '..' after decode, still a quoted key", () => {
		const q = pathToQuery("/foo/%2e%2e/secret");
		expect(parseQuery(q)).toEqual(["foo", "..", "secret"]);
		expect(applyQuery({ foo: { "..": { secret: 9 } } }, q)).toBe(9);
	});
});

describe("plus is not space, and %2B is plus", () => {
	it("keeps a literal + in a path segment as part of the key (not a space)", () => {
		const q = pathToQuery("/a+b");
		expect(q).toBe("['a+b']");
		expect(applyQuery({ "a+b": 3, "a b": 4 }, q)).toBe(3);
	});

	it("decodes %2B to plus, not to space", () => {
		const q = pathToQuery("/a%2Bb");
		expect(q).toBe("['a+b']");
		expect(applyQuery({ "a+b": 3, "a b": 4 }, q)).toBe(3);
	});

	it("decodes %20 to space and quotes it", () => {
		const q = pathToQuery("/a%20b");
		expect(q).toBe("['a b']");
		expect(applyQuery({ "a b": 5, "a+b": 6 }, q)).toBe(5);
	});
});

describe("a leading-plus numeric segment is not an index", () => {
	it("does not treat /+3 as [3]", () => {
		const q = pathToQuery("/+3");
		expect(q).not.toBe("[3]");
		expect(parseQuery(q)).toEqual(["+3"]);
		expect(applyQuery({ "+3": "key", 3: "idx" }, q)).toBe("key");
		expect(applyQuery(["a", "b", "c", "d"], q)).toBeUndefined();
	});

	it("still treats /3 as a numeric index", () => {
		expect(pathToQuery("/3")).toBe("[3]");
		expect(applyQuery(["a", "b", "c", "d"], "[3]")).toBe("d");
	});
});
