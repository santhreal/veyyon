import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

/**
 * The web view of arming and disarming a project's shorthand dictionary.
 *
 * WHY THIS SUITE EXISTS. Neither tool had a renderer. They were not on the list
 * of missing ones either: a first pass that read the tool registry with a regex
 * missed them, because they are registered through a conditional expression
 * rather than a plain factory line, and only the coverage guard in
 * `scripts/tool-renderer-coverage.test.ts` found them. That is the point of
 * checking a list against the tree instead of against itself.
 *
 * Two things are worth rendering and both hide in a JSON dump. The HANDLE COUNT
 * says whether the load bought anything, since a project with a near-empty
 * dictionary loads exactly as successfully as a useful one. And the resolved
 * ROOT is not the path that was asked for: Argot walks from the requested folder
 * up to the nearest project marker, so naming a subdirectory arms its project,
 * and showing only the request would hide which one.
 */

function render(name: string, component: "Summary" | "Body", props: Partial<ToolRenderProps>): string {
	const renderer = resolveToolRenderer(name);
	const Component = component === "Summary" ? renderer.Summary : renderer.Body;
	if (!Component) throw new Error(`${name} renderer has no ${component}`);
	return renderToStaticMarkup(createElement(Component, { name, args: {}, ...props } as ToolRenderProps));
}

function loaded(overrides: Record<string, unknown> = {}): ToolResultLike {
	return {
		content: [{ type: "text", text: "Loaded." }],
		details: { root: "/work/project", handles: 128, requested: "/work/project", ...overrides },
	};
}

describe("argot_load renderer", () => {
	/** Which project got armed is the first thing to know. */
	it("names the project that was loaded", () => {
		const html = render("argot_load", "Summary", { args: { folder_path: "/work/project" }, result: loaded() });

		expect(html).toContain("/work/project");
	});

	/**
	 * The handle count is what says the load was worth making. A dictionary with
	 * two handles loads as successfully as one with two hundred and compresses
	 * nothing, and the result text alone does not distinguish them.
	 */
	it("reports how many handles came with the dictionary", () => {
		const html = render("argot_load", "Summary", { args: {}, result: loaded() });

		expect(html).toContain("128 handles");
	});

	it("uses the singular for a one-handle dictionary", () => {
		const html = render("argot_load", "Summary", { args: {}, result: loaded({ handles: 1 }) });

		expect(html).toContain("1 handle");
		expect(html).not.toContain("1 handles");
	});

	/**
	 * A zero-handle load is the case worth seeing most, and `0` is falsy, so it is
	 * the one a careless render drops.
	 */
	it("still reports a dictionary with no handles", () => {
		const html = render("argot_load", "Summary", { args: {}, result: loaded({ handles: 0 }) });

		expect(html).toContain("0 handles");
	});

	/**
	 * THE RESOLUTION. Asking for a subdirectory arms its project, so both paths
	 * belong in the body: the root says what is armed, the request says what was
	 * typed, and a reader who sees only one cannot tell the walk happened.
	 */
	it("shows the requested path when it differs from the resolved root", () => {
		const result = loaded({ root: "/work/project", requested: "/work/project/packages/inner" });

		const html = render("argot_load", "Body", { args: {}, result });

		expect(html).toContain("/work/project/packages/inner");
		expect(html).toContain("requested");
	});

	/** When they are the same path, showing it twice is noise. */
	it("does not repeat the path when the request already named the root", () => {
		const html = render("argot_load", "Body", { args: {}, result: loaded() });

		expect(html).not.toContain("requested");
	});

	/** Before the call settles there is no root, so the argument stands in. */
	it("falls back to the requested folder while running", () => {
		const html = render("argot_load", "Summary", { args: { folder_path: "/work/project" }, running: true });

		expect(html).toContain("/work/project");
	});
});

describe("argot_unload renderer", () => {
	/**
	 * THE DISTINCTION. `changed: false` means the folder was never taught, so the
	 * call did nothing; reading it as a successful unload tells the reader a
	 * dictionary was dropped that was never armed.
	 */
	it("says when an unload actually dropped a dictionary", () => {
		const result: ToolResultLike = {
			content: [],
			details: { root: "/work/project", changed: true, requested: "/work/project" },
		};

		const html = render("argot_unload", "Body", { args: {}, result });

		expect(html).toContain("unloaded");
		expect(html).not.toContain("was not loaded");
	});

	it("says when there was nothing loaded to drop", () => {
		const result: ToolResultLike = {
			content: [],
			details: { root: "/work/project", changed: false, requested: "/work/project" },
		};

		const html = render("argot_unload", "Summary", { args: {}, result });

		expect(html).toContain("nothing loaded");
		expect(html).toContain("tv-badge--warn");
	});

	/** A missing flag is not a successful unload. */
	it("treats an absent changed flag as nothing having happened", () => {
		const html = render("argot_unload", "Body", { args: {}, result: { content: [] } });

		expect(html).toContain("was not loaded");
	});
});

describe("argot renderers tolerate malformed wire data", () => {
	/**
	 * `details` is plain JSON from the wire. A handle count that is not a number
	 * must be dropped rather than printed as `[object Object]`, and a missing
	 * result must not throw.
	 */
	it("ignores a handle count that is not a number", () => {
		const result: ToolResultLike = { content: [], details: { root: "/work/project", handles: "lots" } };

		const html = render("argot_load", "Summary", { args: {}, result });

		expect(html).toContain("/work/project");
		expect(html).not.toContain("handle");
	});

	it("renders with no result at all", () => {
		// The two halves must stay distinguishable with nothing but the tool
		// name: a load that has not reported yet is not the same event as an
		// unload, and a blank card says neither.
		expect(render("argot_load", "Body", { args: {} })).toContain("loaded");
		expect(render("argot_unload", "Body", { args: {} })).toContain("was not loaded");
	});
});
