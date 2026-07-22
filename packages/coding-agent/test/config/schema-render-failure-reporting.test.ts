/**
 * Regression: a subagent output schema that cannot be rendered must be reported.
 *
 * The `jtdToTypeScript` and `renderYieldSchema` prompt helpers each wrapped the
 * renderer in `catch { return "unknown" }`. Substituting `unknown` is not a
 * graceful degrade, it is the exact failure `renderYieldSchema` was written to
 * prevent: the rendered type is what tells the model the shape it must submit,
 * and with `unknown` in its place the model has nothing to pattern-match on,
 * returns an arbitrary shape, and fails output validation over and over. The
 * operator watches a subagent loop with no indication that its schema never
 * made it into the prompt (Law 10).
 *
 * A RECURSIVE schema used to be the reachable cause: the renderer recursed with
 * no cycle detection, so a schema describing a tree, a linked list, or nested
 * comments overflowed the stack. That is an ordinary thing to want to describe,
 * so the renderer was fixed to expand those into a named interface instead, and
 * this suite pins BOTH halves: that a recursive schema now renders a real type
 * and reports nothing, and that the remaining failure (a schema nested past the
 * depth ceiling) is still reported rather than silently becoming `unknown`.
 *
 * A schema that is empty or not an object is a different case and deliberately
 * stays quiet: it renders as `unknown` WITHOUT throwing, which is a legitimate
 * degenerate result rather than a failure, and warning on it would put a
 * warning on the common path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { logger, prompt } from "@veyyon/utils";

import "@veyyon/coding-agent/config/prompt-templates";

/** A schema that refers to itself, which is what makes the renderer overflow. */
function recursiveSchema(): Record<string, unknown> {
	const schema: Record<string, unknown> = { properties: { name: { type: "string" } } };
	(schema.properties as Record<string, unknown>).child = schema;
	return schema;
}

const RENDER_FAILED =
	"A subagent output schema could not be rendered, so the model is not being told what shape to return";

describe("rendering a subagent output schema into a prompt", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const failures = (): Array<Record<string, unknown>> =>
		warnings.filter(w => w.message === RENDER_FAILED).map(w => w.fields);

	const render = (template: string, schema: unknown): string => prompt.render(template, { outputSchema: schema });

	describe("a schema that renders correctly", () => {
		it("puts the real field types in the prompt", () => {
			// The premise of the whole suite: this is what the model must see, and
			// what a silent `unknown` was replacing.
			const output = render("{{jtdToTypeScript outputSchema}}", {
				properties: { title: { type: "string" }, count: { type: "int32" } },
			});

			expect(output).toContain("title: string;");
			expect(output).toContain("count: number;");
		});

		it("wraps the rendered type in the yield envelope the model must submit", () => {
			const output = render("{{renderYieldSchema outputSchema}}", {
				properties: { title: { type: "string" } },
			});

			expect(output).toContain("result: {");
			expect(output).toContain("data: {");
			expect(output).toContain("title: string;");
		});

		it("reports nothing, so a report means something went wrong", () => {
			// Anti-vacuity. A warning on the working path would make every assertion
			// below pass for the wrong reason.
			render("{{renderYieldSchema outputSchema}}", { properties: { title: { type: "string" } } });

			expect(failures()).toEqual([]);
		});
	});

	describe("a recursive schema, which the renderer now expands into a named interface", () => {
		it("gives the model a real recursive type instead of unknown", () => {
			// This used to overflow the stack and silently become `unknown`. A schema
			// describing a tree or nested comments is an ordinary thing to want, so
			// the renderer names the self-referential node and refers back to it.
			const output = render("{{renderYieldSchema outputSchema}}", recursiveSchema());

			expect(output).toContain("interface Node {");
			expect(output).toContain("name: string;");
			expect(output).toContain("child: Node;");
			expect(output).toContain("data: Node;");
		});

		it("puts the interface declaration before the envelope, never inside it", () => {
			// An `interface` in type position is syntax that does not parse, and a
			// prompt that shows it teaches the model to emit the same thing.
			const output = render("{{renderYieldSchema outputSchema}}", recursiveSchema());

			expect(output.indexOf("interface Node {")).toBeLessThan(output.indexOf("result: {"));
			expect(output).not.toContain("data: interface");
		});

		it("reports nothing, because nothing failed", () => {
			// The whole point of the renderer change: this is a supported schema now,
			// so warning about it would be noise on a working path.
			render("{{renderYieldSchema outputSchema}}", recursiveSchema());

			expect(failures()).toEqual([]);
		});

		it("handles recursion through an array, which is the nested-comments shape", () => {
			// The cycle runs through `elements` rather than a direct property, which
			// is how anyone actually models replies or child nodes.
			const comment: Record<string, unknown> = { properties: { text: { type: "string" } } };
			(comment.properties as Record<string, unknown>).replies = { elements: comment };

			const output = render("{{jtdToTypeScript outputSchema}}", comment);

			expect(output).toContain("interface Node {");
			expect(output).toContain("replies: Node[];");
			expect(failures()).toEqual([]);
		});

		it("renders the same text every time, so the prompt stays cacheable", () => {
			// Names are assigned in first-encounter order. If they depended on
			// iteration accidents the system prompt would change between runs and
			// defeat prompt caching.
			const first = render("{{jtdToTypeScript outputSchema}}", recursiveSchema());
			const second = render("{{jtdToTypeScript outputSchema}}", recursiveSchema());

			expect(first).toBe(second);
		});
	});

	describe("a schema nested past the renderer's depth ceiling", () => {
		/** A finitely deep schema, which cycle detection cannot help with. */
		function tooDeep(): Record<string, unknown> {
			let schema: Record<string, unknown> = { type: "string" };
			for (let i = 0; i < 150; i++) schema = { properties: { next: schema } };
			return schema;
		}

		it("reports that the model is not being told what shape to return", () => {
			// The remaining failure case. It must be a real message rather than a
			// bare `RangeError`, which names neither the schema nor the reason.
			render("{{renderYieldSchema outputSchema}}", tooDeep());

			expect(failures()).toHaveLength(1);
		});

		it("names the depth as the cause rather than reporting a stack overflow", () => {
			render("{{renderYieldSchema outputSchema}}", tooDeep());

			expect(String(failures()[0]?.error)).toContain("levels deep");
			expect(String(failures()[0]?.error)).not.toContain("call stack");
		});

		it("tells the operator what to do and what the symptom will look like", () => {
			// The symptom is a subagent failing validation in a loop, which points
			// nowhere near the schema, so the message has to bridge that gap.
			render("{{renderYieldSchema outputSchema}}", tooDeep());

			expect(String(failures()[0]?.fix)).toContain("Flatten the schema");
			expect(String(failures()[0]?.fix)).toContain("failing output validation");
		});

		it("still renders a usable prompt rather than throwing", () => {
			// Rendering happens while building a subagent's system prompt. Throwing
			// would take down the whole launch for a schema problem the model may
			// still work around, so the fallback stays; only its silence is fixed.
			const output = render("{{renderYieldSchema outputSchema}}", tooDeep());

			expect(output).toContain("data: unknown;");
		});

		it("reports through the bare helper too, not only the yield wrapper", () => {
			// Both helpers had the identical swallow.
			const output = render("{{jtdToTypeScript outputSchema}}", tooDeep());

			expect(output).toBe("unknown");
			expect(failures()).toHaveLength(1);
		});

		it("reports at warn, not debug, because the subagent is now unable to succeed", () => {
			// The original silence is one demotion away from returning.
			const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

			render("{{renderYieldSchema outputSchema}}", tooDeep());

			expect(failures()).toHaveLength(1);
			expect(debug).not.toHaveBeenCalled();
		});
	});

	describe("a schema that is simply empty, which is not a failure", () => {
		it.each([
			[null, "null"],
			[undefined, "undefined"],
			["not a schema", "a string"],
			[{}, "an empty object"],
		])("renders %s (%s) as unknown without reporting anything", schema => {
			// These render as `unknown` WITHOUT throwing. Treating them as failures
			// would put a warning on a legitimate degenerate case, and a warning that
			// fires when nothing is wrong is how the real one stops being read.
			const output = render("{{jtdToTypeScript outputSchema}}", schema);

			expect(output).toBe("unknown");
			expect(failures()).toEqual([]);
		});
	});
});
