/**
 * A cell that is only `return;` must not wrap-and-discard.
 *
 * WHY THIS SUITE EXISTS. `wrapCode` wraps a cell that contains a top-level
 * `return` in an async IIFE so the worker can wait it out. The IIFE's return
 * value is thrown away; the published result is whatever
 * `returnFinalExpression` rewrote into `__veyyon_set_final_expr__`. A bare
 * `return;` has no argument, so a rewrite that only matches `return <expr>`
 * leaves the `return;` inside the IIFE, the IIFE returns `undefined`, and
 * that undefined is discarded. The cell then looks like it ran and produced
 * nothing.
 *
 * `return 7;` is already owned by wrap-code-nested-return. This file is the
 * argument-less form, including whitespace / comments between `return` and
 * `;`.
 */
import { describe, expect, it } from "bun:test";
import { wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

describe("bare top-level return; is rewritten, not swallowed by the wrapper", () => {
	it("return; publishes undefined via the final-expression helper rather than discarding the IIFE return", async () => {
		const result = await wrapCode("return;");
		expect(result.source).toContain("__veyyon_set_final_expr__");
		expect(result.source).not.toMatch(/(^|\n)\s*return;\s*$/);
	});

	it("return ; with a space before the semicolon is the same statement", async () => {
		const result = await wrapCode("return ;");
		expect(result.source).toContain("__veyyon_set_final_expr__");
	});

	it("return undefined; is rewritten, not left as a discarded IIFE return", async () => {
		const result = await wrapCode("return undefined;");
		expect(result.source).toContain("__veyyon_set_final_expr__");
		expect(result.source).toContain("undefined");
	});
});
