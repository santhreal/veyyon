import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * The durable guard for a class of defect that reached a user twice.
 *
 * A tool result is the only thing the model sees. When the words in it disagree
 * with the status the agent loop records, the model acts on the words and the
 * loop is scored on the status, and the two diverge in ways that look like the
 * model malfunctioning:
 *
 *   H1-60 `set_cwd` described a SUCCESS in words that read as failure
 *         ("Session cwd unchanged"). A real agent retried it in a loop.
 *   H1-62 `image_gen` returned a FAILURE as an ordinary success result
 *         ("No image data returned.", no `isError`). The loop recorded `ok`, so
 *         the model was told a request that produced nothing had worked.
 *   `ask` returned "Error: questions must not be empty" with no `isError`, the
 *         same inversion in a validation path.
 *
 * Those were found by reading. This test finds them mechanically: it scans every
 * tool source for a result whose text opens with unambiguous failure wording and
 * fails if that result is not also marked `isError`. Throwing is fine too, since
 * a thrown error never reaches this shape.
 *
 * The vocabulary below is deliberately narrow. "No relevant memories found" and
 * "No message within 30s" are honest answers to a question, not failures, and
 * must keep passing; only wording that states the tool could not do the thing is
 * matched.
 */
describe("tool results that read as failures are marked as failures", () => {
	const TOOLS_DIR = path.join(import.meta.dir, "..", "src", "tools");

	/**
	 * Wording that can only mean "this call did not do what you asked". Anchored
	 * at the start of the string so a mention mid-sentence (`...if this failed,
	 * retry`) does not trip the scan.
	 */
	const FAILURE_OPENERS = /^(Error\b|Failed\b|Cannot\b|Could not\b|Unable to\b|Refused\b|Denied\b)/i;

	interface Violation {
		file: string;
		line: number;
		text: string;
	}

	/**
	 * Every `text:` string literal in the file that opens with failure wording,
	 * paired with whether the `return { ... }` object enclosing it sets `isError`.
	 *
	 * The enclosing object is found by walking back to the nearest `return {` and
	 * brace-matching forward from it, which is exact for the shape every tool
	 * uses. A `text:` that is not inside a `return {` (a thrown message, a helper
	 * building a string) is skipped, because those paths cannot produce an
	 * unmarked success.
	 */
	function scan(file: string): Violation[] {
		const source = readFileSync(path.join(TOOLS_DIR, file), "utf8");
		const violations: Violation[] = [];
		const textLiteral = /text:\s*(`|")((?:[^`"\\]|\\.)*)\1/g;

		for (const match of source.matchAll(textLiteral)) {
			const literal = match[2];
			if (!FAILURE_OPENERS.test(literal)) continue;

			const start = source.lastIndexOf("return {", match.index);
			if (start === -1) continue;
			let depth = 0;
			let end = start;
			for (let i = source.indexOf("{", start); i < source.length; i++) {
				if (source[i] === "{") depth++;
				else if (source[i] === "}" && --depth === 0) {
					end = i;
					break;
				}
			}
			if (end <= match.index) continue; // the literal is not inside this return
			if (/\bisError\b/.test(source.slice(start, end))) continue;

			violations.push({
				file,
				line: source.slice(0, match.index).split("\n").length,
				text: literal.slice(0, 80),
			});
		}
		return violations;
	}

	const toolFiles = readdirSync(TOOLS_DIR).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));

	it("scans a tool surface large enough for the check to mean something", () => {
		// If the directory moves or the filter breaks, every assertion below passes
		// vacuously. This is the tripwire for that.
		expect(toolFiles.length).toBeGreaterThan(20);
	});

	it("finds no unmarked failure result in any tool", () => {
		const violations = toolFiles.flatMap(scan);

		expect(
			violations.map(v => `${v.file}:${v.line} ${JSON.stringify(v.text)} returns failure wording without isError`),
		).toEqual([]);
	});

	describe("the scan itself", () => {
		// A scan that cannot fail is worse than no scan. These pin its behavior on
		// fabricated sources so a future refactor of the matcher cannot quietly
		// turn it into a no-op.

		it("matches the exact shape that shipped in ask.ts", () => {
			expect(FAILURE_OPENERS.test("Error: questions must not be empty")).toBe(true);
		});

		it("matches the other openers a tool is likely to reach for", () => {
			for (const text of [
				"Failed to write the file.",
				"Cannot create managed skill",
				"Could not reach the provider.",
				"Unable to resolve the path.",
			]) {
				expect(FAILURE_OPENERS.test(text)).toBe(true);
			}
		});

		it("does not match an honest empty-result report", () => {
			// These are correct answers to a question and must never be forced to
			// carry isError; doing so would make a successful search look broken.
			for (const text of [
				"No relevant memories found.",
				"No message from alice within 30s.",
				"Nothing to discard; no pending action remains.",
				"Session cwd is /tmp. Your requested path resolved to that same directory.",
			]) {
				expect(FAILURE_OPENERS.test(text)).toBe(false);
			}
		});

		it("does not match failure wording that appears mid-sentence", () => {
			// Guidance text routinely mentions failure without being one.
			for (const text of [
				"Wrote 3 files. If a later step failed, rerun with --force.",
				"Done. The previous attempt could not resolve the host.",
			]) {
				expect(FAILURE_OPENERS.test(text)).toBe(false);
			}
		});
	});
});
