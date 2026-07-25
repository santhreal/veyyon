/**
 * A tool call whose arguments will not serialize must not render as a call with no arguments.
 *
 * WHY THIS SUITE EXISTS. The `history://` transcript summarizes each tool call as
 * `→ name(<primary arg>)`. When no single argument stands out, the summary falls back to a compact
 * JSON of the remaining arguments, and `JSON.stringify` can throw: a circular reference or a BigInt
 * in the arguments is enough. That throw was caught and turned into `""`, which is the same value
 * the formatter produces for a call that genuinely takes no arguments, so `→ write()` was printed
 * for a `write` that had a path and a body, indistinguishable from the `{}` a truly empty argument
 * object prints. The transcript is what a reader reconstructs a session from, and a call rendered as
 * argument-less is not a vague answer, it is a wrong one.
 *
 * The fallback now names the argument keys instead. Those keys are exactly what survives when the
 * values do not: they are plain strings, so listing them cannot throw for the same reason the
 * stringify did, and they tell the reader which arguments were present and that their values could
 * not be shown.
 *
 * These tests go through `formatSessionHistoryMarkdown`, the only exported entry point, because the
 * rendered line is the contract. Asserting the internal helper would let the line regress while the
 * suite stayed green.
 */

import { describe, expect, it } from "bun:test";
import { formatSessionHistoryMarkdown } from "@veyyon/coding-agent/session/session-history-format";

/** One assistant turn holding a single tool call, which is the smallest input that renders a call line. */
function transcriptWithCall(name: string, args: Record<string, unknown>): unknown[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-1", name, arguments: args }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "toolUse",
			timestamp: 1,
		},
	];
}

/** Arguments that hold a cycle: `JSON.stringify` throws `TypeError: Converting circular structure`. */
function circularArgs(): Record<string, unknown> {
	const node: Record<string, unknown> = { depth: 1 };
	node.self = node;
	return { graph: node, limit: 4 };
}

describe("arguments that cannot be serialized", () => {
	/**
	 * The exact bug. A circular argument used to erase every argument from the line. The rendered call
	 * must still show that arguments were passed, and must name them.
	 */
	it("names the argument keys instead of rendering an empty call", () => {
		const markdown = formatSessionHistoryMarkdown(transcriptWithCall("analyze", circularArgs()));

		expect(markdown).toContain("→ analyze({unserializable: graph, limit})");
		expect(markdown).not.toContain("→ analyze()");
	});

	/**
	 * A BigInt is the other everyday way `JSON.stringify` throws, and it throws a different error
	 * (`TypeError: Do not know how to serialize a BigInt`). Checked separately so a fix that only
	 * handled cycles cannot pass the test above and still blank this line.
	 */
	it("handles a BigInt argument, not only a circular reference", () => {
		const markdown = formatSessionHistoryMarkdown(transcriptWithCall("count", { total: 9n, scale: 2 }));

		expect(markdown).toContain("→ count({unserializable: total, scale})");
	});

	/** Key order follows the arguments, so the reader sees them in the order the caller wrote them. */
	it("lists the keys in argument order", () => {
		const node: Record<string, unknown> = {};
		node.loop = node;
		const markdown = formatSessionHistoryMarkdown(transcriptWithCall("walk", { zeta: 1, alpha: node, mid: true }));

		expect(markdown).toContain("{unserializable: zeta, alpha, mid}");
	});

	/**
	 * A single unserializable argument must not read as a list, and the marker must still carry its
	 * name: the name is the whole reason the marker is better than the empty string it replaced.
	 */
	it("names a lone unserializable argument", () => {
		const node: Record<string, unknown> = {};
		node.self = node;
		const markdown = formatSessionHistoryMarkdown(transcriptWithCall("inspect", { subject: node }));

		expect(markdown).toContain("→ inspect({unserializable: subject})");
	});
});

describe("what still takes precedence over the fallback", () => {
	/**
	 * The fallback is last. A string argument is a better summary than any marker, so a call that has
	 * one renders it even when a sibling argument would have broken the stringify, and the marker must
	 * not appear at all.
	 */
	it("prefers a string argument over the marker", () => {
		const node: Record<string, unknown> = {};
		node.self = node;
		const markdown = formatSessionHistoryMarkdown(transcriptWithCall("read", { path: "src/config.ts", graph: node }));

		expect(markdown).toContain("→ read(src/config.ts)");
		expect(markdown).not.toContain("unserializable");
	});

	/**
	 * The two argument-less renderings are still correct, and they are what the old `""` collided with:
	 * an empty arguments object prints `{}`, and a call with no arguments at all prints nothing between
	 * the parentheses. A reader seeing either is entitled to conclude no values were passed, which is
	 * precisely the conclusion the silent fallback invited them to draw about a call that had values.
	 */
	it("still renders a genuinely argument-less call as empty", () => {
		expect(formatSessionHistoryMarkdown(transcriptWithCall("status", {}))).toContain("→ status({})");

		const noArgs = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "status" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "toolUse",
				timestamp: 1,
			},
		];
		expect(formatSessionHistoryMarkdown(noArgs)).toContain("→ status()");
	});

	/** Serializable arguments with no obvious primary still render as compact JSON, unchanged. */
	it("still renders serializable arguments as JSON", () => {
		const markdown = formatSessionHistoryMarkdown(transcriptWithCall("resize", { width: 80, height: 24 }));

		expect(markdown).toContain('→ resize({"width":80,"height":24})');
		expect(markdown).not.toContain("unserializable");
	});
});

describe("the marker never breaks the line format", () => {
	/**
	 * The transcript is line-based: one tool call is one line, and the reader (and every downstream
	 * parser of `history://`) depends on that. A marker built from key names must not introduce a
	 * newline, however the arguments were shaped.
	 */
	it("keeps the call on a single line", () => {
		const node: Record<string, unknown> = {};
		node.self = node;
		const markdown = formatSessionHistoryMarkdown(
			transcriptWithCall("run", { "key\nwith\nnewlines": node, other: 1 }),
		);
		const callLine = markdown.split("\n").find(line => line.includes("unserializable"));

		expect(callLine).toBeDefined();
		expect(callLine).toContain("→ run(");
		expect(callLine).toContain(")");
	});
});
