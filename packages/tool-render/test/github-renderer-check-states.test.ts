import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

/**
 * The web view of a GitHub Actions run watch, over the shared check-run vocabulary.
 *
 * WHY THIS SUITE EXISTS. This renderer used to carry its own copy of the conclusion tables
 * that `coding-agent/src/tools/gh-renderer.ts` also carried, and the two had drifted: the
 * terminal side knew a queued/requested/waiting/pending group, this one did not. Both now read
 * `@veyyon/utils/github-check-run`, so a conclusion taught to one view is taught to both. These
 * cases drive the real renderer for each state so the shared classification is proven where a
 * reader actually sees it, not just at the table.
 */

function renderWatch(jobs: readonly Record<string, unknown>[], run: Record<string, unknown>): string {
	const result: ToolResultLike = {
		content: [{ type: "text", text: "watching" }],
		details: {
			watch: {
				repo: "santhreal/veyyon",
				mode: "run",
				state: "watching",
				run: { id: 42, workflowName: "CI", ...run, jobs },
			},
		},
	};
	const renderer = resolveToolRenderer("github");
	const Body = renderer.Body;
	if (!Body) throw new Error("github renderer has no Body");
	return renderToStaticMarkup(
		createElement(Body, { name: "github", args: { op: "run_watch" }, result } as ToolRenderProps),
	);
}

/** The class each state paints its job glyph with, as the view's own mapping. */
const OK = "tv-ok-text";
const ERR = "tv-err-text";
const WARN = "tv-warn-text";
const UNSET = "tv-faint";

describe("github run-watch job states", () => {
	it("paints a successful job with the success class", () => {
		const html = renderWatch([{ id: 1, name: "build", status: "completed", conclusion: "success" }], {
			status: "completed",
			conclusion: "success",
		});
		expect(html).toContain(`<span class="${OK}">✓</span>`);
	});

	/**
	 * `startup_failure` is a failure this renderer's own table listed, and the one a copied table
	 * is most likely to lose: it never appears in a passing run.
	 */
	it("paints every failure conclusion with the failure class, startup_failure included", () => {
		for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "startup_failure"]) {
			const html = renderWatch([{ id: 1, name: "build", status: "completed", conclusion }], {
				status: "completed",
				conclusion,
			});
			expect(html).toContain(`<span class="${ERR}">✕</span>`);
		}
	});

	it("paints a running job with the in-flight class", () => {
		const html = renderWatch([{ id: 1, name: "build", status: "in_progress" }], { status: "in_progress" });
		expect(html).toContain(`<span class="${WARN}">●</span>`);
	});

	/**
	 * A queued job has not started, so it must not read as running: `queued` shared a prefix with
	 * nothing in this file's old table and fell through to the unstarted glyph, which is the state
	 * it still belongs in. What the shared vocabulary fixes is that both views agree it is not
	 * running and not failed.
	 */
	it("keeps a queued job out of the running and failed states", () => {
		for (const status of ["queued", "requested", "waiting", "pending"]) {
			const html = renderWatch([{ id: 1, name: "build", status }], { status });
			expect(html).toContain(`<span class="${UNSET}">○</span>`);
			expect(html).not.toContain(WARN);
			expect(html).not.toContain(ERR);
		}
	});

	/**
	 * GitHub reports the previous conclusion beside `status: "in_progress"` on a re-run. Reading
	 * the status first would show a finished failure as still running.
	 */
	it("lets the conclusion win over a status reported beside it", () => {
		const html = renderWatch([{ id: 1, name: "build", status: "in_progress", conclusion: "failure" }], {
			status: "in_progress",
			conclusion: "failure",
		});
		expect(html).toContain(`<span class="${ERR}">✕</span>`);
		expect(html).not.toContain(`<span class="${WARN}">●</span>`);
	});
});
