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
	 * Every `text:` string literal in the source that opens with failure wording, paired with whether
	 * the `return { ... }` object enclosing it is a tool result and sets `isError`.
	 *
	 * The enclosing object is found by walking back to the nearest `return {` and
	 * brace-matching forward from it, which is exact for the shape every tool
	 * uses. A `text:` that is not inside a `return {` (a thrown message, a helper
	 * building a string) is skipped, because those paths cannot produce an
	 * unmarked success.
	 */
	function scanSource(file: string, source: string): Violation[] {
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
			const enclosing = source.slice(start, end);
			// A RESULT, NOT A ROW. `text:` is also the span field a `ToolView` row carries, and a tool
			// that describes its card returns rows from the same module the results are built in
			// (`Error: ${sanitizeErrorText(text)}` is a row a view draws for a failure the loop has
			// already marked). Only an object that also carries `content:` can be what the model reads,
			// so the check is anchored on that rather than on the module's name, which a rename defeats.
			if (!/\bcontent\s*:/.test(enclosing)) continue;
			if (/\bisError\b/.test(enclosing)) continue;

			violations.push({
				file,
				line: source.slice(0, match.index).split("\n").length,
				text: literal.slice(0, 80),
			});
		}
		return violations;
	}

	function scan(file: string): Violation[] {
		return scanSource(file, readFileSync(path.join(TOOLS_DIR, file), "utf8"));
	}

	/**
	 * Every tool module, at any depth. A flat `readdirSync` read the tools directory when every tool
	 * was a file in it; the tools now sit in domain directories, so a flat read finds `index.ts`,
	 * `renderers.ts` and nothing else, and every assertion below passes for want of a subject. The
	 * floor in the next cell is what turns that back into a red run.
	 */
	function toolModules(dir: string, prefix = ""): string[] {
		const found: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name === "__tests__") continue;
				found.push(...toolModules(path.join(dir, entry.name), rel));
				continue;
			}
			if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(rel);
		}
		return found;
	}

	const toolFiles = toolModules(TOOLS_DIR);

	it("scans a tool surface large enough for the check to mean something", () => {
		// If the directory moves or the filter breaks, every assertion below passes
		// vacuously. This is the tripwire for that.
		expect(toolFiles.length).toBeGreaterThan(20);
		// And it reaches into the domain directories rather than stopping at the two modules that
		// stayed at the top: a sweep that lost the tools themselves would still clear the floor above.
		expect(toolFiles).toContain("fs/read.ts");
		expect(toolFiles).toContain("shell/bash.ts");
		expect(toolFiles).toContain("agent/ask.ts");
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
				"Cwd stays at /tmp. Your requested path resolved to the directory the session was already in, so nothing moved.",
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

		it("flags an unmarked failure result and clears the same wording in a card's row", () => {
			// The discrimination the scan rests on. A result is what the model reads, so failure
			// wording in one without `isError` is the defect; the identical sentence in a `ToolView`
			// row is a card describing a failure the loop has already marked, and a scan that cannot
			// tell them apart is one that gets switched off.
			const unmarked = `function run() {\n\treturn { content: [{ type: "text", text: "Error: no image data returned." }] };\n}`;
			const marked = `function run() {\n\treturn { content: [{ type: "text", text: "Error: no image data returned." }], isError: true };\n}`;
			const row = `function renderResult() {\n\treturn { text: "Error: no image data returned.", tone: "error" };\n}`;

			expect(scanSource("fabricated/tool.ts", unmarked).map(v => v.text)).toEqual([
				"Error: no image data returned.",
			]);
			expect(scanSource("fabricated/tool.ts", marked)).toEqual([]);
			expect(scanSource("fabricated/tool-view.ts", row)).toEqual([]);
		});
	});
});
