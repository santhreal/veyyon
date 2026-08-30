/**
 * A displayed path collapses the operator's home directory to `~`, and only when the path is really
 * under it.
 *
 * WHY THIS SUITE EXISTS. `src/tools/shorten-path.ts` is the node-side owner of that collapse: the
 * launch card's status row and every tool renderer reach it, and a leaked absolute path carries the
 * operator's username into a transcript, an export and a shared session. Nothing named the module.
 * It was covered only through whatever a status-row suite happened to render, so the boundary case
 * that makes the rule correct -- a sibling directory whose name merely starts with the home path --
 * was asserted nowhere.
 *
 * WHAT IT DOES NOT CATCH. Whether a caller uses it. The browser packages have their own owner in
 * `@veyyon/tool-render`, deliberately, and this says nothing about that one.
 */
import { describe, expect, it } from "bun:test";
import { shortenPath } from "@veyyon/coding-agent/tools/shorten-path";

describe("a displayed path hides the home directory", () => {
	it("shows a path under the home directory as a tilde path", () => {
		expect(shortenPath("/home/operator/src/app.ts", "/home/operator")).toBe("~/src/app.ts");
	});

	it("shows the home directory itself as a bare tilde", () => {
		expect(shortenPath("/home/operator", "/home/operator")).toBe("~");
	});

	/**
	 * THE boundary. `/home/operator2` starts with `/home/operator` and is a different account, so a
	 * prefix test alone would rewrite it to `~2` -- a path that resolves nowhere and still leaks the
	 * name it claimed to hide.
	 */
	it("leaves a sibling directory whose name starts with the home path alone", () => {
		expect(shortenPath("/home/operator2/src/app.ts", "/home/operator")).toBe("/home/operator2/src/app.ts");
	});

	it("collapses a Windows home directory and reports forward slashes", () => {
		expect(shortenPath("C:\\Users\\operator\\src\\app.ts", "C:\\Users\\operator")).toBe("~/src/app.ts");
	});

	it("answers with the empty string for input that is not a path", () => {
		// The status row calls this with whatever a tool put in its arguments, which is not always a
		// string. Throwing there would take the frame down over a cosmetic field.
		expect(shortenPath(undefined, "/home/operator")).toBe("");
		expect(shortenPath(42, "/home/operator")).toBe("");
	});

	it("leaves a path outside the home directory unchanged", () => {
		expect(shortenPath("/srv/veyyon/app.ts", "/home/operator")).toBe("/srv/veyyon/app.ts");
	});
});
