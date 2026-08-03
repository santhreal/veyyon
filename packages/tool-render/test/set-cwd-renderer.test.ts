import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

/**
 * The web view of a re-root.
 *
 * WHY THIS SUITE EXISTS. `set_cwd` had no renderer at all, so every re-root fell
 * through to the generic JSON dump on the web surface while the terminal showed
 * a readable line. The information that matters most is the RULE DELTA: a
 * re-root changes which `AGENTS.md` / `CLAUDE.md` files govern the session,
 * because they are found by walking up from the working directory, and a move
 * that silently swapped the governing rules looked identical to one that changed
 * nothing. These tests assert the rendered markup, not the component's internals,
 * because the markup is what a reader actually sees.
 *
 * `details` arrives as plain JSON over the wire and is not trusted: it may be
 * absent while the call is still running, and it may be the wrong shape. Half of
 * what follows is about not crashing on either.
 */

const renderer = resolveToolRenderer("set_cwd");

function render(component: "Summary" | "Body", props: Partial<ToolRenderProps>): string {
	const Component = component === "Summary" ? renderer.Summary : renderer.Body;
	if (!Component) throw new Error(`set_cwd renderer has no ${component}`);
	return renderToStaticMarkup(createElement(Component, { name: "set_cwd", args: {}, ...props } as ToolRenderProps));
}

/** A settled call that moved and swapped one rule file for another. */
function movedResult(overrides: Record<string, unknown> = {}): ToolResultLike {
	return {
		content: [{ type: "text", text: "Working directory: /work/beta" }],
		details: {
			previous: "/work/alpha",
			cwd: "/work/beta",
			requested: "/work/beta",
			rulesApplied: ["/work/beta/AGENTS.md"],
			rulesDropped: ["/work/alpha/AGENTS.md"],
			rulesUnchanged: 1,
			...overrides,
		},
	};
}

describe("set_cwd summary", () => {
	/**
	 * The destination is the headline. Reading only "cwd" and a rule count would
	 * leave the one question a reader has, where am I now, unanswered.
	 */
	it("names the destination directory", () => {
		const html = render("Summary", { args: { path: "/work/beta" }, result: movedResult() });

		expect(html).toContain("/work/beta");
	});

	/**
	 * Counts in the summary, names in the body. A rule file path is long and the
	 * summary is one line, so naming them here would push the destination out of
	 * view; the count is enough to tell a rule-changing move from a quiet one.
	 */
	it("reports the rule delta as counts, not names", () => {
		const html = render("Summary", { args: { path: "/work/beta" }, result: movedResult() });

		expect(html).toContain("+1 -1 rule files");
		expect(html).not.toContain("AGENTS.md");
	});

	/**
	 * Singular and plural are separate strings and both get read, so both are
	 * pinned. One file changing is the common case.
	 */
	it("uses the singular when exactly one rule file changed", () => {
		const result = movedResult({ rulesDropped: [] });

		const html = render("Summary", { args: { path: "/work/beta" }, result });

		expect(html).toContain("+1 rule file");
		expect(html).not.toContain("rule files");
	});

	/**
	 * A move that changed no rules must say nothing about rules rather than
	 * "+0 -0". Silence is the correct report for nothing having happened.
	 */
	it("says nothing about rules when the delta is empty", () => {
		const result = movedResult({ rulesApplied: [], rulesDropped: [] });

		const html = render("Summary", { args: { path: "/work/beta" }, result });

		expect(html).not.toContain("rule file");
		expect(html).toContain("/work/beta");
	});

	/**
	 * A re-root to the directory already in force is a real and common call, and
	 * reading it as a move would be a small lie every time it happens.
	 */
	it("marks a no-op re-root as already here", () => {
		const result: ToolResultLike = {
			content: [{ type: "text", text: "Working directory: /work/alpha" }],
			details: { previous: "/work/alpha", cwd: "/work/alpha", requested: ".", rulesApplied: [], rulesDropped: [] },
		};

		const html = render("Summary", { args: { path: "." }, result });

		expect(html).toContain("already here");
	});

	/**
	 * While the call is in flight there is no `details` at all, so the summary has
	 * only the argument to go on. A running re-root should still say where it is
	 * heading rather than rendering a bare question mark.
	 */
	it("falls back to the requested path while the call is running", () => {
		const html = render("Summary", { args: { path: "/work/beta" }, running: true });

		expect(html).toContain("/work/beta");
		expect(html).not.toContain("already here");
	});

	/**
	 * A failed re-root is not a completed one. The tone badge is the only thing
	 * distinguishing them at a glance in a long transcript.
	 */
	it("renders an error tone when the call failed", () => {
		const failed: ToolResultLike = {
			content: [{ type: "text", text: "Not a directory: /work/nope" }],
			isError: true,
			details: { previous: "/work/alpha", cwd: "/work/alpha", requested: "/work/nope" },
		};

		const html = render("Summary", { args: { path: "/work/nope" }, result: failed });

		expect(html).toContain("tv-badge--err");
	});
});

describe("set_cwd body", () => {
	/**
	 * The body is where the names belong, and both directions matter: a reader
	 * needs to know which rules started applying AND which stopped, because the
	 * second is what explains behaviour that used to happen and no longer does.
	 */
	it("names the rule files that started and stopped applying", () => {
		const html = render("Body", { args: { path: "/work/beta" }, result: movedResult() });

		expect(html).toContain("now applies");
		expect(html).toContain("/work/beta/AGENTS.md");
		expect(html).toContain("no longer applies");
		expect(html).toContain("/work/alpha/AGENTS.md");
	});

	/** Where the session came from is half of what a move means. */
	it("shows both ends of the move", () => {
		const html = render("Body", { args: { path: "/work/beta" }, result: movedResult() });

		expect(html).toContain("/work/alpha");
		expect(html).toContain("/work/beta");
		expect(html).toContain("re-rooted");
	});

	/**
	 * An empty delta is stated rather than left blank. A body that simply omits
	 * the rules section reads as "not reported yet", which is a different claim
	 * from "nothing changed".
	 */
	it("states an empty rule delta explicitly", () => {
		const result = movedResult({ rulesApplied: [], rulesDropped: [] });

		const html = render("Body", { args: { path: "/work/beta" }, result });

		expect(html).toContain("The rule files in effect are unchanged.");
	});

	/** A no-op re-root is labelled as such here too, not as a move. */
	it("labels a no-op re-root unchanged", () => {
		const result: ToolResultLike = {
			content: [],
			details: { previous: "/work/alpha", cwd: "/work/alpha", requested: "." },
		};

		const html = render("Body", { args: { path: "." }, result });

		expect(html).toContain("unchanged");
		expect(html).not.toContain("re-rooted");
	});
});

describe("set_cwd renderer tolerates malformed wire data", () => {
	/**
	 * `details` is plain JSON from the wire and every renderer in this package is
	 * required to survive it. These are the shapes that would have thrown: a
	 * non-array where a list is expected, non-strings inside the list, and no
	 * details at all.
	 */
	it("ignores a rules field that is not an array", () => {
		const result: ToolResultLike = {
			content: [],
			details: { previous: "/a", cwd: "/b", rulesApplied: "AGENTS.md", rulesDropped: 7 },
		};

		expect(() => render("Body", { args: {}, result })).not.toThrow();
		expect(render("Summary", { args: {}, result })).not.toContain("rule file");
	});

	it("keeps only the string entries of a mixed list", () => {
		const result: ToolResultLike = {
			content: [],
			details: { previous: "/a", cwd: "/b", rulesApplied: ["/b/AGENTS.md", 42, null, { path: "x" }] },
		};

		const html = render("Body", { args: {}, result });

		expect(html).toContain("/b/AGENTS.md");
		expect(html).not.toContain("42");
	});

	it("renders with no details at all", () => {
		// With nothing settled the card must still say what happened, not go
		// blank: a reroot that did not move is a different event from a reroot
		// whose result has not arrived, and both have to be readable.
		expect(render("Body", { args: { path: "/work/beta" } })).toContain("unchanged");
		expect(render("Summary", { args: {} })).toContain("cwd");
	});
});
