import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

/**
 * The web view of the three tools that write DURABLE state: `learn`,
 * `manage_skill`, and `memory_edit`.
 *
 * WHY THIS SUITE EXISTS. None of them had a renderer, so all three fell through
 * to the generic JSON dump. They are grouped because they share one property
 * that makes the dump especially bad: their effects outlive the session. A
 * `learn` call that also writes a skill changes what the agent reaches for in
 * later sessions, `manage_skill delete` removes a capability, and
 * `memory_edit forget` destroys a stored fact. Each of those is a different
 * event from its harmless-looking siblings, and telling them apart at a glance
 * is exactly what a transcript reader needs.
 *
 * These tools carry no `details` at all, so everything rendered comes from the
 * ARGUMENTS. That makes tolerance of malformed arguments load-bearing rather
 * than defensive decoration.
 */

function render(name: string, component: "Summary" | "Body", props: Partial<ToolRenderProps>): string {
	const renderer = resolveToolRenderer(name);
	const Component = component === "Summary" ? renderer.Summary : renderer.Body;
	if (!Component) throw new Error(`${name} renderer has no ${component}`);
	return renderToStaticMarkup(createElement(Component, { name, args: {}, ...props } as ToolRenderProps));
}

const OK: ToolResultLike = { content: [{ type: "text", text: "Lesson stored." }] };

describe("learn renderer", () => {
	/** The lesson is the point of the call, so it leads. */
	it("shows the lesson", () => {
		const html = render("learn", "Summary", {
			args: { memory: "the fetch dispatcher must stop on a deadline instead of degrading" },
			result: OK,
		});

		expect(html).toContain("the fetch dispatcher must stop on a deadline");
	});

	/**
	 * A call that also writes a skill is a different event, and the summary has to
	 * say so: it changes future behaviour rather than just recording a fact.
	 */
	it("calls out a skill written in the same call", () => {
		const html = render("learn", "Summary", {
			args: {
				memory: "a lesson",
				skill: { action: "create", name: "deadline-audit", description: "when to audit deadlines", body: "# body" },
			},
			result: OK,
		});

		expect(html).toContain("skill created");
		expect(html).toContain("deadline-audit");
	});

	/** Create and update are different claims about what existed before. */
	it("distinguishes an updated skill from a created one", () => {
		const html = render("learn", "Summary", {
			args: {
				memory: "a lesson",
				skill: { action: "update", name: "deadline-audit", description: "d", body: "# body" },
			},
			result: OK,
		});

		expect(html).toContain("skill updated");
		expect(html).not.toContain("skill created");
	});

	/** A plain lesson must not grow a skill badge it never asked for. */
	it("says nothing about skills when none was written", () => {
		const html = render("learn", "Summary", { args: { memory: "a lesson" }, result: OK });

		expect(html).not.toContain("skill");
	});

	/**
	 * The skill body is what the agent will read next time, so the body view shows
	 * it rather than summarising it away.
	 */
	it("shows the skill body in the expanded view", () => {
		const html = render("learn", "Body", {
			args: {
				memory: "a lesson",
				skill: {
					action: "create",
					name: "n",
					description: "d",
					body: "## When to use\nAlways check the deadline.",
				},
			},
			result: OK,
		});

		expect(html).toContain("Always check the deadline.");
		expect(html).toContain("SKILL.md");
	});

	/** `skill` is untrusted wire data: a non-object must be ignored, not crash. */
	it("ignores a skill argument that is not an object", () => {
		const html = render("learn", "Summary", { args: { memory: "a lesson", skill: "deadline-audit" }, result: OK });

		expect(html).toContain("a lesson");
		expect(html).not.toContain("skill created");
	});
});

describe("manage_skill renderer", () => {
	/** Which of the three actions ran is the first thing a reader needs. */
	it("names the action and the skill", () => {
		const html = render("manage_skill", "Summary", {
			args: { action: "create", name: "deadline-audit", description: "d", body: "b" },
			result: OK,
		});

		expect(html).toContain("create");
		expect(html).toContain("deadline-audit");
	});

	/**
	 * Delete is the destructive one and must not read like a create. The tone class
	 * is the only thing carrying that difference at a glance.
	 */
	it("marks a delete as the destructive action", () => {
		const html = render("manage_skill", "Summary", { args: { action: "delete", name: "old-skill" }, result: OK });

		expect(html).toContain("tv-badge--warn");
		expect(html).toContain("old-skill");
	});

	it("does not mark a create as destructive", () => {
		const html = render("manage_skill", "Summary", {
			args: { action: "create", name: "new-skill", description: "d", body: "b" },
			result: OK,
		});

		expect(html).toContain("tv-badge--ok");
		expect(html).not.toContain("tv-badge--warn");
	});

	/**
	 * A delete carries neither description nor body, so the body view is the badge
	 * and nothing else. That is correct rather than a gap, and pinning it stops a
	 * later change from inventing empty sections.
	 */
	it("renders a delete with no body content", () => {
		const html = render("manage_skill", "Body", { args: { action: "delete", name: "old-skill" }, result: OK });

		expect(html).toContain("old-skill");
		expect(html).not.toContain("SKILL.md");
	});
});

describe("memory_edit renderer", () => {
	/** The id is how a reader ties the edit back to the memory it changed. */
	it("names the operation and the memory id", () => {
		const html = render("memory_edit", "Summary", { args: { op: "update", id: "mem_42" }, result: OK });

		expect(html).toContain("update");
		expect(html).toContain("mem_42");
	});

	/**
	 * An invalidate says one memory supersedes another, and that second id is the
	 * whole point of the operation.
	 */
	it("shows both ids for an invalidate", () => {
		const html = render("memory_edit", "Summary", {
			args: { op: "invalidate", id: "mem_42", replacement_id: "mem_99" },
			result: OK,
		});

		expect(html).toContain("mem_42");
		expect(html).toContain("mem_99");
	});

	/** Forget destroys a stored fact, so it reads as the destructive one. */
	it("marks a forget as destructive", () => {
		const html = render("memory_edit", "Summary", { args: { op: "forget", id: "mem_42" }, result: OK });

		expect(html).toContain("tv-badge--warn");
	});

	/** An update carries the replacement content, which is what actually changed. */
	it("shows the replacement content for an update", () => {
		const html = render("memory_edit", "Body", {
			args: { op: "update", id: "mem_42", content: "the corrected fact", importance: 0.8 },
			result: OK,
		});

		expect(html).toContain("the corrected fact");
		expect(html).toContain("0.8");
	});

	/** Every one of these renders from args alone, so absent args must be survivable. */
	it("renders with no arguments at all", () => {
		// Surviving means degrading to the identifying chip, not to a blank card.
		expect(render("memory_edit", "Body", { args: {} })).toContain("memory");
		expect(render("manage_skill", "Body", { args: {} })).toContain("skill");
		// `learn` is deliberately the exception: with no lesson, no context and
		// no skill there is nothing to expand, and the card head already names
		// the tool. What it must never do is invent a skill chip for a call that
		// wrote no skill, which would read as a skill having been created.
		expect(render("learn", "Body", { args: {} })).toBe("");
	});
});
