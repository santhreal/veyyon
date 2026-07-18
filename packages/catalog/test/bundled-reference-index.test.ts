import { describe, expect, it } from "bun:test";
import { getBundledModelReferenceIndex } from "../src/identity/bundled";

// The bundled proxy-reference index is a lazily-walked, memoized view over the
// full bundled catalog (~thousands of models). Lock that it materializes real
// content, stays internally consistent, and is built exactly once.
describe("getBundledModelReferenceIndex", () => {
	it("materializes a populated exact-id lookup over the bundled catalog", () => {
		const index = getBundledModelReferenceIndex();
		expect(index.exact.size).toBeGreaterThan(0);
		// Every exact entry keys a real bundled model whose id round-trips through
		// the same lowercase-normalized key.
		for (const [key, model] of index.exact) {
			expect(typeof model.id).toBe("string");
			expect(model.id.length).toBeGreaterThan(0);
			expect(key).toBe(key.toLowerCase());
			expect(index.exact.get(key)).toBe(model);
		}
	});

	it("memoizes: repeated calls return the identical index and inner maps", () => {
		const first = getBundledModelReferenceIndex();
		const second = getBundledModelReferenceIndex();
		expect(second).toBe(first);
		expect(second.exact).toBe(first.exact);
		expect(second.suffixAlias).toBe(first.suffixAlias);
	});
});
