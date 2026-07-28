/**
 * The bounded JSON walk costs two modules, and neither of them is about secrets.
 *
 * WHY THIS SUITE EXISTS. `mapJsonStrings` rewrites every string in a JSON value, keys
 * included, under hard depth/node/key/byte limits. Three callers want three different
 * rewrites: `secrets/obfuscator.ts` swaps credentials for placeholders, `argot-wire.ts`
 * expands and contracts a token dictionary, and `provider-boundary.ts` applies whatever
 * transform the session hands it at the final outbound seam. Only the first is a secret.
 *
 * It lived at the bottom of `secrets/obfuscator.ts` anyway, and that had a price nobody
 * could see from either end. The obfuscator reaches 65 modules, EIGHTEEN of them
 * `@veyyon/ai/utils/schema` -- a JSON Schema validator, on the graph because the obfuscator
 * redacts tool schemas through `toolWireSchema`. `provider-boundary.ts` imported one
 * function and got all of it, and since the boundary is on the graph of everything that can
 * make an outbound request, so did they: `tools/read.ts` was 24 modules over its ceiling and
 * every one of the 24 was that edge. Reading a local file loaded a schema validator.
 *
 * So this file guards the shape of the fix rather than the number in the ceiling. The
 * ceiling in `leveraged-imports-stay-cut.test.ts` moves when anything on a large graph
 * moves; these assertions fail for exactly one reason, which is that the walk grew an
 * import it has no business having.
 */

import { describe, expect, it } from "bun:test";
import { reach, reachedNames } from "../helpers/module-reach-gate";

describe("the JSON walk", () => {
	/**
	 * THE COST, exactly. Two modules: itself and `@veyyon/utils/string-length`, which owns
	 * the two measurements it needs (`utf8ByteLength` for the byte limits,
	 * `isWellFormedUtf16` for the round-trip refusal) and imports nothing. An exact count
	 * rather than a ceiling, because there is no third thing a JSON walk should need and a
	 * gate that permits growth invites it.
	 */
	it("costs exactly two modules", () => {
		expect(reachedNames("json-transform.ts")).toEqual([
			"coding-agent/src/json-transform.ts",
			"utils/src/string-length.ts",
		]);
	});

	/**
	 * The cut, stated as the absence it is. Named separately from the count above because
	 * this is the failure that matters: a future edit that imports one helper from
	 * `secrets/` or one type from `@veyyon/ai` re-attaches the whole graph, and the count
	 * test would fail without saying why.
	 */
	it("reaches nothing under secrets/ and nothing in @veyyon/ai", () => {
		const reached = reachedNames("json-transform.ts");

		expect(reached.filter(name => name.includes("/secrets/"))).toEqual([]);
		expect(reached.filter(name => name.startsWith("ai/"))).toEqual([]);
	});

	/**
	 * The seam that motivated the move. `provider-boundary.ts` is reached by every module
	 * that can send text to a provider, so its cost is paid by all of them: it was 66
	 * modules and is 3 (itself, the walk, the measurements).
	 */
	it("leaves the outbound provider seam at three modules", () => {
		expect(reachedNames("provider-boundary.ts")).toEqual([
			"coding-agent/src/json-transform.ts",
			"coding-agent/src/provider-boundary.ts",
			"utils/src/string-length.ts",
		]);
	});

	/**
	 * ANTI-VACUITY, and it is essential here. Every assertion above is an absence, so a
	 * resolution table that stopped resolving `@veyyon/ai` would make all of them pass while
	 * measuring nothing. The obfuscator still reaches the schema validator, because it
	 * genuinely redacts tool schemas; that is what makes the absence above a real cut rather
	 * than a walk that stopped early.
	 */
	it("is a real cut, not a walk that stopped early", () => {
		const obfuscator = reachedNames("secrets/obfuscator.ts");

		expect(obfuscator).toContain("ai/src/utils/schema/index.ts");
		expect(obfuscator.filter(name => name.startsWith("ai/src/utils/schema/")).length).toBeGreaterThan(10);
		expect(reach("secrets/obfuscator.ts")).toBeGreaterThan(reach("json-transform.ts") * 10);
	});

	/**
	 * The compatibility half. The obfuscator re-exports the names that moved, so the twenty
	 * or so call sites and test files that import them from there keep working, and the
	 * re-export must be the SAME function rather than a second copy that could drift: a
	 * duplicated walker with duplicated limits is the exact failure the move was supposed
	 * to prevent.
	 */
	it("is one function, whichever module you import it from", async () => {
		const [own, viaObfuscator] = await Promise.all([
			import("@veyyon/coding-agent/json-transform"),
			import("@veyyon/coding-agent/secrets/obfuscator"),
		]);

		expect(viaObfuscator.mapJsonStrings).toBe(own.mapJsonStrings);
		expect(viaObfuscator.MAX_JSON_TRANSFORM_DEPTH).toBe(own.MAX_JSON_TRANSFORM_DEPTH);
		expect(viaObfuscator.MAX_JSON_TRANSFORM_NODES).toBe(own.MAX_JSON_TRANSFORM_NODES);
		expect(viaObfuscator.MAX_JSON_TRANSFORM_KEYS).toBe(own.MAX_JSON_TRANSFORM_KEYS);
		expect(viaObfuscator.MAX_JSON_TRANSFORM_STRING_BYTES).toBe(own.MAX_JSON_TRANSFORM_STRING_BYTES);
	});

	/**
	 * And it still walks. The move was a cut-and-paste of two hundred lines, which is the
	 * kind of change that typechecks whatever happens to it, so this drives the function
	 * from its new home over the cases that distinguish a working walk from a broken one:
	 * keys as well as values, nesting, an untouched value returned by identity, and a
	 * refusal that must still fire.
	 */
	it("still rewrites keys and values, and still refuses what it always refused", async () => {
		const { mapJsonStrings } = await import("@veyyon/coding-agent/json-transform");
		const upper = (text: string) => text.toUpperCase();

		const nested: Record<string, unknown> = { key: ["a", { deep: "b" }] };
		expect(mapJsonStrings(nested, upper)).toEqual({ KEY: ["A", { DEEP: "B" }] });

		// Identity by REFERENCE, not just by value: the walk allocates only containers whose
		// key or value actually changed, and the keys here are already uppercase.
		const unchanged = { A: 1, B: [true, null] };
		expect(mapJsonStrings(unchanged, upper)).toBe(unchanged);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => mapJsonStrings(cyclic, upper)).toThrow(/cyclic/i);
		expect(() => mapJsonStrings({ a: "x", b: "x" }, () => "same")).toThrow(/same protected key/i);
		expect(() => mapJsonStrings("\ud800", upper)).toThrow(/ill-formed UTF-16/i);
	});
});
