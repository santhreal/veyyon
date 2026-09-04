/**
 * BLOCK_RESOLVER_UNAVAILABLE exact substring.
 */
import { describe, expect, it } from "bun:test";
import { BLOCK_RESOLVER_UNAVAILABLE } from "../src/messages";

describe("BLOCK_RESOLVER_UNAVAILABLE exact", () => {
	it("mentions resolver and concrete range", () => {
		expect(BLOCK_RESOLVER_UNAVAILABLE).toContain("no block resolver");
		expect(BLOCK_RESOLVER_UNAVAILABLE).toContain("SWAP.BLK");
		expect(BLOCK_RESOLVER_UNAVAILABLE).toContain("concrete line range");
	});
});
