import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

/**
 * The web view of a checkpoint and the rewind that consumes it.
 *
 * WHY THIS SUITE EXISTS. Neither tool had a renderer, so both fell through to
 * the generic JSON dump. That matters more here than for most tools: a rewind
 * DISCARDS the context between the checkpoint and itself and keeps only the
 * report, so the report is the only surviving record of that stretch of the
 * session. Reading a transcript to find where state was rolled back, and what
 * was carried across, is a normal thing to do and it should not require parsing
 * JSON.
 *
 * The distinction these tests protect hardest is `rewound: true` versus a call
 * that did not rewind. They produce nearly identical JSON and mean opposite
 * things about whether the intervening context still exists.
 */

function render(name: string, component: "Summary" | "Body", props: Partial<ToolRenderProps>): string {
	const renderer = resolveToolRenderer(name);
	const Component = component === "Summary" ? renderer.Summary : renderer.Body;
	if (!Component) throw new Error(`${name} renderer has no ${component}`);
	return renderToStaticMarkup(createElement(Component, { name, args: {}, ...props } as ToolRenderProps));
}

describe("checkpoint renderer", () => {
	/**
	 * The goal is the whole content of a checkpoint. A badge with no goal would
	 * tell a reader that something was marked without saying what for.
	 */
	it("names the goal it was created for", () => {
		const result: ToolResultLike = {
			content: [{ type: "text", text: "Checkpoint created." }],
			details: { goal: "find why the fetch tool degrades on a timeout", startedAt: "2026-07-25T10:00:00.000Z" },
		};

		const html = render("checkpoint", "Summary", { args: { goal: "find why the fetch tool degrades" }, result });

		expect(html).toContain("find why the fetch tool degrades on a timeout");
	});

	/**
	 * Details win over args when both are present, because the tool records what it
	 * actually stored rather than what it was asked to store.
	 */
	it("prefers the recorded goal over the requested one", () => {
		const result: ToolResultLike = {
			content: [],
			details: { goal: "recorded goal", startedAt: "2026-07-25T10:00:00.000Z" },
		};

		const html = render("checkpoint", "Summary", { args: { goal: "requested goal" }, result });

		expect(html).toContain("recorded goal");
		expect(html).not.toContain("requested goal");
	});

	/** While the call is in flight there is no result, so the argument is all there is. */
	it("falls back to the requested goal while running", () => {
		const html = render("checkpoint", "Summary", { args: { goal: "in-flight goal" }, running: true });

		expect(html).toContain("in-flight goal");
	});

	/** The timestamp is what makes two checkpoints in one session tellable apart. */
	it("shows when the checkpoint was taken", () => {
		const result: ToolResultLike = {
			content: [],
			details: { goal: "a goal", startedAt: "2026-07-25T10:00:00.000Z" },
		};

		const html = render("checkpoint", "Body", { args: {}, result });

		expect(html).toContain("2026-07-25T10:00:00.000Z");
	});
});

describe("rewind renderer", () => {
	/**
	 * THE DISTINCTION THIS FILE EXISTS FOR. A completed rewind and a call that did
	 * not rewind differ by one boolean and mean opposite things about whether the
	 * context between the checkpoint and here still exists.
	 */
	it("says the context was rewound when it was", () => {
		const result: ToolResultLike = {
			content: [{ type: "text", text: "Rewind requested." }],
			details: { report: "the deadline was swallowed by the retry loop", rewound: true },
		};

		const html = render("rewind", "Body", { args: {}, result });

		expect(html).toContain("context rewound");
		expect(html).not.toContain("not rewound");
	});

	it("does not claim a rewind that did not happen", () => {
		const result: ToolResultLike = {
			content: [{ type: "text", text: "No active checkpoint." }],
			isError: true,
			details: { report: "", rewound: false },
		};

		const html = render("rewind", "Body", { args: {}, result });

		expect(html).toContain("not rewound");
	});

	/**
	 * The report survives the rewind and nothing else does, so the body shows it
	 * whole rather than truncated to a summary line.
	 */
	it("shows the report in full in the body", () => {
		const report = ["line one of the findings", "line two", "line three"].join("\n");
		const result: ToolResultLike = { content: [], details: { report, rewound: true } };

		const html = render("rewind", "Body", { args: {}, result });

		expect(html).toContain("line one of the findings");
		expect(html).toContain("line three");
		expect(html).toContain("report");
	});

	/** The summary is one line, so the same report is cut down there. */
	it("truncates the report in the summary", () => {
		const report = "x".repeat(400);
		const result: ToolResultLike = { content: [], details: { report, rewound: true } };

		const html = render("rewind", "Summary", { args: {}, result });

		expect(html).toContain("rewound");
		expect(html.length).toBeLessThan(300);
	});

	/**
	 * `details` is plain JSON from the wire, so a missing or wrong-shaped field
	 * must not throw and must not be read as a successful rewind.
	 */
	it("treats a missing rewound flag as not rewound", () => {
		const html = render("rewind", "Body", { args: { report: "from the args" }, result: { content: [] } });

		expect(html).toContain("not rewound");
		expect(html).toContain("from the args");
	});

	it("renders with no result at all", () => {
		expect(() => render("rewind", "Body", { args: {} })).not.toThrow();
		expect(() => render("checkpoint", "Body", { args: {} })).not.toThrow();
	});
});
