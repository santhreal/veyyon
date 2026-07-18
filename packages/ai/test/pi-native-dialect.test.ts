import { describe, expect, it } from "bun:test";
import type { Context, ToolCall } from "@veyyon/ai";
import { createInbandScanner, getDialectDefinition, type InbandScanEvent } from "@veyyon/ai/dialect";

// Spec: docs/internal/toolconv/pi-native.md — the test names cite its sections.

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, offset: { type: "number" } },
			required: ["path"],
		},
	},
	{
		name: "bash",
		description: "Run a command",
		parameters: {
			type: "object",
			properties: { command: { type: "string" }, timeout: { type: "number" } },
			required: ["command"],
		},
	},
	{
		name: "edit",
		description: "Apply a patch",
		parameters: {
			type: "object",
			properties: { input: { type: "string" } },
			required: ["input"],
		},
	},
	{
		name: "write",
		description: "Write a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
	{
		name: "configure",
		description: "Configure",
		parameters: {
			type: "object",
			properties: {
				object: {
					type: "object",
					properties: { list: { type: "array", items: { type: "string" } }, y: { type: "number" } },
				},
			},
		},
	},
	{
		name: "tag",
		description: "Tag files",
		parameters: {
			type: "object",
			properties: {
				labels: { type: "array", items: { type: "string" } },
				ports: { type: "array", items: { type: "number" } },
			},
		},
	},
] as unknown as NonNullable<Context["tools"]>;

function feed(text: string, options: { tools?: typeof TOOLS; chunked?: boolean; parseThinking?: boolean } = {}) {
	const scanner = createInbandScanner("pi-native", {
		tools: options.tools ?? TOOLS,
		parseThinking: options.parseThinking ?? true,
	});
	const events: InbandScanEvent[] = [];
	if (options.chunked === false) {
		events.push(...scanner.feed(text));
	} else {
		for (const char of text) events.push(...scanner.feed(char));
	}
	events.push(...scanner.flush());
	return events;
}

function calls(events: readonly InbandScanEvent[]) {
	return events.filter((e): e is Extract<InbandScanEvent, { type: "toolEnd" }> => e.type === "toolEnd");
}

function textOf(events: readonly InbandScanEvent[]): string {
	return events
		.filter((e): e is Extract<InbandScanEvent, { type: "text" }> => e.type === "text")
		.map(e => e.text)
		.join("");
}

describe("pi-native scanner: tool-call forms", () => {
	it("parses the attribute form (self-closing, schema-coerced)", () => {
		const [call] = calls(feed('<call:read path="src/server/auth.ts"/>'));
		expect(call?.name).toBe("read");
		expect(call?.arguments).toEqual({ path: "src/server/auth.ts" });
	});

	it("coerces non-string attributes as JSON and keeps string attributes verbatim", () => {
		const [call] = calls(feed('<call:bash command="ls -la" timeout=30/>'));
		expect(call?.arguments).toEqual({ command: "ls -la", timeout: 30 });
	});

	it("parses the element form with schema-driven scalar coercion", () => {
		const [call] = calls(feed("<call:read>\n<path>src/server/auth.ts</path>\n<offset>50</offset>\n</call:read>"));
		expect(call?.arguments).toEqual({ path: "src/server/auth.ts", offset: 50 });
	});

	it('keeps a numeric-looking string-typed element verbatim (spec: <path>4</path> is "4")', () => {
		const [call] = calls(feed("<call:read>\n<path>4</path>\n</call:read>"));
		expect(call?.arguments).toEqual({ path: "4" });
	});

	it("combines call-tag attributes with child elements", () => {
		const [call] = calls(feed('<call:read path="src/server/auth.ts">\n<offset>50</offset>\n</call:read>'));
		expect(call?.arguments).toEqual({ path: "src/server/auth.ts", offset: 50 });
	});

	it("captures the inline body verbatim including markup-looking text", () => {
		const body = "*** Begin Patch\n@@ src/server/auth.ts\n-  return user;\n+  return user ?? null;\n*** End Patch";
		const [call] = calls(feed(`<call:edit>\n${body}\n</call:edit>`));
		expect(call?.arguments).toEqual({ input: body });
	});

	it("fills the first unset string parameter when attributes cover the rest", () => {
		const [call] = calls(feed('<call:write path="notes/todo.md">\n# TODO\n- ship pi-native parser\n</call:write>'));
		expect(call?.arguments).toEqual({ path: "notes/todo.md", content: "# TODO\n- ship pi-native parser" });
	});

	it("preserves interior whitespace and strips only the two block-delimiter newlines", () => {
		const [call] = calls(feed("<call:edit>\n  indented\n\ntrailing line  \n</call:edit>"));
		expect(call?.arguments).toEqual({ input: "  indented\n\ntrailing line  " });
	});
});

describe("pi-native scanner: value model", () => {
	it('treats attribute quotes as delimiters, not type markers (y="4" is the number 4)', () => {
		const [call] = calls(feed('<call:configure>\n<object y="4">\n<list>x</list>\n</object>\n</call:configure>'));
		expect(call?.arguments).toEqual({ object: { y: 4, list: ["x"] } });
	});

	it("reads a bare attribute with no value as boolean true", () => {
		const [call] = calls(feed("<call:configure>\n<object dry_run/>\n</call:configure>", { tools: [] as never }));
		expect(call?.arguments).toEqual({ object: { dry_run: true } });
	});

	it("repeats elements into arrays with item-type coercion", () => {
		const [call] = calls(feed("<call:tag>\n<ports>80</ports>\n<ports>443</ports>\n</call:tag>"));
		expect(call?.arguments).toEqual({ ports: [80, 443] });
	});

	it("yields a one-element array for a single occurrence of an array-typed field", () => {
		const [call] = calls(feed("<call:tag>\n<labels>x</labels>\n</call:tag>"));
		expect(call?.arguments).toEqual({ labels: ["x"] });
	});

	it("parses nested objects recursively with attrs and repeated children", () => {
		const [call] = calls(
			feed("<call:configure>\n<object y=4>\n<list>alpha</list>\n<list>beta</list>\n</object>\n</call:configure>"),
		);
		expect(call?.arguments).toEqual({ object: { y: 4, list: ["alpha", "beta"] } });
	});

	it("falls back to JSON coercion and repetition counts without a schema", () => {
		const events = feed(
			"<call:unknown>\n<n>4</n>\n<name>foo.ts</name>\n<flag>true</flag>\n<item>a</item>\n<item>b</item>\n</call:unknown>",
			{
				tools: [] as never,
			},
		);
		const [call] = calls(events);
		expect(call?.arguments).toEqual({ n: 4, name: "foo.ts", flag: true, item: ["a", "b"] });
	});
});

describe("pi-native scanner: streaming", () => {
	it("emits toolStart as soon as the open tag closes and streams inline-body deltas", () => {
		const scanner = createInbandScanner("pi-native", { tools: TOOLS });
		const events: InbandScanEvent[] = [];
		events.push(...scanner.feed("<call:edit>\nchunk one "));
		expect(events.some(e => e.type === "toolStart" && e.name === "edit")).toBe(true);
		const before = events.filter(e => e.type === "toolArgDelta").length;
		expect(before).toBeGreaterThan(0);
		events.push(...scanner.feed("chunk two\n</call:edit>"));
		events.push(...scanner.flush());
		const deltas = events
			.filter((e): e is Extract<InbandScanEvent, { type: "toolArgDelta" }> => e.type === "toolArgDelta")
			.map(e => e.delta)
			.join("");
		expect(deltas).toBe("chunk one chunk two");
		expect(calls(events)[0]?.arguments).toEqual({ input: "chunk one chunk two" });
	});

	it("holds back a partial trailing closer instead of leaking it into the body", () => {
		const body = "keep </call:ed inside";
		const events = feed(`<call:edit>\n${body}\n</call:edit>`);
		expect(calls(events)[0]?.arguments).toEqual({ input: body });
	});

	it("survives single-character feeding for every form", () => {
		const events = feed('<call:read path="a.ts" offset=2/><call:edit>\nbody\n</call:edit>');
		const ends = calls(events);
		expect(ends).toHaveLength(2);
		expect(ends[0]?.arguments).toEqual({ path: "a.ts", offset: 2 });
		expect(ends[1]?.arguments).toEqual({ input: "body" });
	});

	it("emits surrounding prose as text and keeps parallel calls in order", () => {
		const events = feed('before <call:read path="a.ts"/>\n<call:read path="b.ts"/> after');
		const ends = calls(events);
		expect(ends.map(e => e.arguments.path)).toEqual(["a.ts", "b.ts"]);
		expect(textOf(events)).toContain("before ");
		expect(textOf(events)).toContain(" after");
	});

	it("parses <think> blocks into thinking events when enabled", () => {
		const events = feed('<think>plan it</think><call:read path="a.ts"/>');
		const end = events.find(e => e.type === "thinkingEnd");
		expect(end && "thinking" in end ? end.thinking : "").toBe("plan it");
		expect(calls(events)).toHaveLength(1);
	});

	it("drops an unterminated call at flush instead of emitting a half call", () => {
		const events = feed("<call:edit>\nnever closed");
		expect(calls(events)).toHaveLength(0);
	});

	it("passes stray text that merely resembles a call opener through as text", () => {
		const events = feed("a < b and <call: is not a call");
		expect(calls(events)).toHaveLength(0);
		expect(textOf(events)).toBe("a < b and <call: is not a call");
	});
});

describe("pi-native end-to-end (spec example)", () => {
	it("parses the four-call spec example with all three forms plus nesting", () => {
		const turn = [
			"I'll inspect the file, run the tests, then apply the fix.",
			"",
			'<call:read path="src/server/auth.ts"/>',
			"",
			'<call:bash command="bun test src/server/auth.test.ts" timeout=120/>',
			"",
			"<call:configure>",
			"<object y=4>",
			"<list>alpha</list>",
			"<list>beta</list>",
			"</object>",
			"</call:configure>",
			"",
			"<call:edit>",
			"*** Begin Patch",
			"@@ src/server/auth.ts",
			"-  return user;",
			"+  return user ?? null;",
			"*** End Patch",
			"</call:edit>",
		].join("\n");
		const ends = calls(feed(turn));
		expect(ends.map(e => ({ name: e.name, arguments: e.arguments }))).toEqual([
			{ name: "read", arguments: { path: "src/server/auth.ts" } },
			{ name: "bash", arguments: { command: "bun test src/server/auth.test.ts", timeout: 120 } },
			{ name: "configure", arguments: { object: { y: 4, list: ["alpha", "beta"] } } },
			{
				name: "edit",
				arguments: {
					input: "*** Begin Patch\n@@ src/server/auth.ts\n-  return user;\n+  return user ?? null;\n*** End Patch",
				},
			},
		]);
	});
});

describe("pi-native renderer", () => {
	const definition = getDialectDefinition("pi-native");

	function toolCall(name: string, args: Record<string, unknown>): ToolCall {
		return { type: "toolCall", id: "t1", name, arguments: args };
	}

	function roundTrip(call: ToolCall): Record<string, unknown> | undefined {
		const rendered = definition.renderToolCall(call, { tools: TOOLS });
		return calls(feed(rendered))[0]?.arguments;
	}

	it("renders all-scalar arguments as a self-closing attribute form", () => {
		const rendered = definition.renderToolCall(toolCall("read", { path: "a.ts", offset: 2 }), { tools: TOOLS });
		expect(rendered).toBe('<call:read path="a.ts" offset=2/>');
	});

	it("renders a bulk string as the verbatim inline body", () => {
		const patch = "*** Begin Patch\nline < with & markup\n*** End Patch";
		const rendered = definition.renderToolCall(toolCall("edit", { input: patch }), { tools: TOOLS });
		expect(rendered).toBe(`<call:edit>\n${patch}\n</call:edit>`);
	});

	it("renders write with the path attribute and content inline body", () => {
		const rendered = definition.renderToolCall(
			toolCall("write", { path: "notes/todo.md", content: "# TODO\n- ship it" }),
			{ tools: TOOLS },
		);
		expect(rendered).toBe('<call:write path="notes/todo.md">\n# TODO\n- ship it\n</call:write>');
	});

	it("renders structured arguments in element form with array repetition", () => {
		const rendered = definition.renderToolCall(toolCall("tag", { ports: [80, 443] }), { tools: TOOLS });
		expect(rendered).toBe("<call:tag>\n<ports>80</ports>\n<ports>443</ports>\n</call:tag>");
	});

	it("round-trips every form back through the scanner", () => {
		expect(roundTrip(toolCall("read", { path: "a.ts", offset: 2 }))).toEqual({ path: "a.ts", offset: 2 });
		expect(roundTrip(toolCall("edit", { input: "patch < body & text" }))).toEqual({ input: "patch < body & text" });
		expect(roundTrip(toolCall("write", { path: "p.md", content: "multi\nline" }))).toEqual({
			path: "p.md",
			content: "multi\nline",
		});
		expect(roundTrip(toolCall("tag", { labels: ["x"], ports: [80, 443] }))).toEqual({
			labels: ["x"],
			ports: [80, 443],
		});
		expect(roundTrip(toolCall("configure", { object: { y: 4, list: ["alpha", "beta"] } }))).toEqual({
			object: { y: 4, list: ["alpha", "beta"] },
		});
	});

	it("renders parallel calls as consecutive blocks", () => {
		const rendered = definition.renderAssistantToolCalls(
			[toolCall("read", { path: "a.ts" }), toolCall("read", { path: "b.ts" })],
			{ tools: TOOLS },
		);
		const ends = calls(feed(rendered));
		expect(ends.map(e => e.arguments.path)).toEqual(["a.ts", "b.ts"]);
	});

	it("falls back to element form when the inline body would contain its own closer", () => {
		const evil = "text containing </call:edit> inside";
		const rendered = definition.renderToolCall(toolCall("edit", { input: evil }), { tools: TOOLS });
		expect(rendered).not.toContain(`\n${evil}\n</call:edit>`);
		expect(calls(feed(rendered))[0]?.arguments).toEqual({ input: evil });
	});
});
