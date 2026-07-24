/**
 * HomeAnchorLayout — the home-screen anchor extracted from interactive-mode
 * (ARCH-2, layout slice). These tests exist because the anchor math was
 * previously untestable inside the god-file: a regression in the slack split
 * or the re-anchor rule shows up only as a composer drifting off the viewport
 * bottom or bouncing mid-stream, which no static check catches. Each rule
 * (2/5 optical centring, stateless re-anchor with no permanent latch-off,
 * exact-frame dismissal math, change-only re-render) is pinned here with
 * exact row counts.
 */
import { describe, expect, test } from "bun:test";
import type { TUI } from "@veyyon/tui";
import { HomeAnchorLayout, type HomeAnchorPort } from "../../../src/modes/controllers/home-anchor-layout";

/** A root component of fixed height, standing in for welcome/status/composer. */
function block(rows: number) {
	return { render: () => Array.from({ length: rows }, () => "") };
}

function makeHarness(options: {
	rows: number;
	contentRows: number;
	composedFrameRows?: number;
	transcriptChildren?: number;
	hasHero?: boolean;
}) {
	const state = {
		composedFrameRows: options.composedFrameRows ?? 0,
		transcriptChildren: options.transcriptChildren ?? 0,
		hasHero: options.hasHero ?? false,
		renderRequests: 0,
	};
	const children: Array<{ render: (width: number) => readonly string[] }> = [block(options.contentRows)];
	const ui = {
		terminal: { columns: 80, rows: options.rows },
		get composedFrameRows() {
			return state.composedFrameRows;
		},
		children,
		requestRender: () => {
			state.renderRequests++;
		},
	} as unknown as TUI;
	const port: HomeAnchorPort = {
		ui,
		transcriptChildCount: () => state.transcriptChildren,
		hasHero: () => state.hasHero,
	};
	const layout = new HomeAnchorLayout(port);
	// The real tree mounts both fills as root children; the remeasure walk must
	// skip them or it would count its own output as content.
	children.unshift(layout.topFill);
	children.push(layout.bottomFill);
	return { layout, state, children };
}

const rowsOf = (s: { render: (w: number) => readonly string[] }) => s.render(80).length;

describe("HomeAnchorLayout.sync — home-screen slack", () => {
	test("with the hero up, 2/5 of the slack tops the hero and the rest sinks the composer", () => {
		// 30-row terminal, 8 rows of content -> 22 slack. floor(22*2/5)=8 top,
		// 14 bottom. The 2/5 (not 1/2) split is deliberate: slightly above true
		// centre reads optically centred.
		const { layout } = makeHarness({ rows: 30, contentRows: 8, hasHero: true });
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(8);
		expect(rowsOf(layout.bottomFill)).toBe(14);
	});

	test("with the hero dismissed, all slack goes below so the composer pins to the bottom edge", () => {
		const { layout } = makeHarness({ rows: 30, contentRows: 8, hasHero: false });
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(0);
		expect(rowsOf(layout.bottomFill)).toBe(22);
	});

	test("prefers the composed frame height when one exists, subtracting its own fills", () => {
		// Steady state: composedFrameRows (12) includes the current fills (0+0
		// on first sync), so content = 12 and slack = 30-12 = 18.
		const { layout } = makeHarness({ rows: 30, contentRows: 99, composedFrameRows: 12 });
		layout.sync();
		expect(rowsOf(layout.bottomFill)).toBe(18);
	});

	test("remeasure sums the live children instead of the stale composed frame", () => {
		// The submit-frame bug this rule prevents: composedFrameRows is one
		// frame stale, so right after content mounts it would reserve empty-home
		// slack on top of the new rows and overflow. remeasure=true walks the
		// real children (10 rows), not the stale frame (2 rows).
		const { layout } = makeHarness({ rows: 30, contentRows: 10, composedFrameRows: 2 });
		layout.sync(true);
		expect(rowsOf(layout.bottomFill)).toBe(20);
	});
});

describe("HomeAnchorLayout — stateless re-anchor, no latch-off", () => {
	test("fills collapse while the conversation fills the viewport, and re-anchor when slack returns", () => {
		// The 2026-07-23 glitch: a transient tall frame (a streaming preview
		// spike) latched the anchor off for good, then the collapse left the
		// composer stranded mid-screen above a blank slab. The anchor is
		// stateless now: fills vanish at slack zero and return the moment the
		// frame shrinks, so the composer hugs the bottom in every state.
		const { layout, state } = makeHarness({
			rows: 20,
			contentRows: 25,
			composedFrameRows: 25,
			transcriptChildren: 1,
		});
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(0);
		expect(rowsOf(layout.bottomFill)).toBe(0);
		// The spike collapses: slack returns, and the conversation hug routing
		// puts ALL of it above the transcript (composer stays on the bottom).
		state.composedFrameRows = 12;
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(8);
		expect(rowsOf(layout.bottomFill)).toBe(0);
	});

	test("an overflowing home screen keeps anchoring once rows free up", () => {
		// A tiny terminal where the welcome card fills every row: fills are
		// zero while there is no slack, and return the moment there is — the
		// anchor never disengages permanently.
		const { layout, state } = makeHarness({
			rows: 10,
			contentRows: 15,
			composedFrameRows: 15,
			transcriptChildren: 0,
			hasHero: true,
		});
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(0);
		state.composedFrameRows = 4;
		layout.sync();
		// Hero centring: 2/5 of the 6 slack rows above, the rest below.
		expect(rowsOf(layout.topFill)).toBe(2);
		expect(rowsOf(layout.bottomFill)).toBe(4);
	});
});

describe("HomeAnchorLayout.onFrameComposed — the drift correction", () => {
	test("requests a render only when a fill actually changed", () => {
		// The async-content case (e.g. the MCP status line mounting after the
		// fill was seeded): the correction must repaint. The steady-state case
		// must NOT repaint, or every composed frame would schedule another.
		const { layout, state } = makeHarness({ rows: 30, contentRows: 8, composedFrameRows: 8 });
		layout.onFrameComposed();
		expect(state.renderRequests).toBe(1); // 0 -> 22 bottom fill: changed
		// The requested render composes the next frame WITH the fill in it.
		state.composedFrameRows = 30;
		layout.onFrameComposed();
		expect(state.renderRequests).toBe(1); // steady state: no extra render
	});

	test("keeps correcting after the viewport fills — no permanent latch-off", () => {
		// The pre-2026-07-23 latch made onFrameComposed inert forever after one
		// overflowing frame, so a later collapse never re-anchored (the stranded
		// composer glitch). The correction must stay live: a shrink re-fills and
		// requests the repaint.
		const { layout, state } = makeHarness({
			rows: 20,
			contentRows: 25,
			composedFrameRows: 25,
			transcriptChildren: 1,
		});
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(0);
		state.composedFrameRows = 12;
		layout.onFrameComposed();
		expect(rowsOf(layout.topFill)).toBe(8);
		expect(state.renderRequests).toBe(1);
	});
});

describe("HomeAnchorLayout.onHeroDismissed — same-frame re-anchor", () => {
	test("re-anchors from the live children on this frame, not the next", () => {
		// Hero centred on a 30-row terminal: top 8, bottom 14, content 8 (of
		// which the hero block is 6). Dismissal unmounts the hero BEFORE the
		// layout callback runs, so the direct remeasure sees the surviving 2
		// content rows and the bottom fill becomes 28 to keep the composer on
		// the bottom edge without waiting for the next compose.
		const { layout, state, children } = makeHarness({ rows: 30, contentRows: 8, hasHero: true });
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(8);
		expect(rowsOf(layout.bottomFill)).toBe(14);
		state.composedFrameRows = 30;
		state.hasHero = false;
		children[1] = block(2);
		layout.onHeroDismissed(14);
		expect(rowsOf(layout.topFill)).toBe(0);
		expect(rowsOf(layout.bottomFill)).toBe(28);
		expect(state.renderRequests).toBe(1);
	});

	test("falls back to a full sync when no composed frame exists yet", () => {
		// Dismissal before the first paint (a keystroke racing startup): there
		// is no frame to do exact math against, so the layout re-syncs from the
		// live children instead of guessing.
		const { layout, state } = makeHarness({ rows: 30, contentRows: 8, hasHero: false });
		layout.onHeroDismissed(5);
		expect(rowsOf(layout.bottomFill)).toBe(22);
		expect(state.renderRequests).toBe(1);
	});
});

describe("HomeAnchorLayout — interactive-mode delegation (source lock)", () => {
	test("interactive-mode owns no fill math: it mounts the controller's fills and delegates every sync", async () => {
		// A parallel lane clobbered the welcome extraction once (2026-07-22);
		// this lock makes any re-inlining of the anchor math a loud failure.
		const source = await Bun.file(new URL("../../../src/modes/interactive-mode.ts", import.meta.url)).text();
		expect(source).toContain("this.#layout = new HomeAnchorLayout({");
		expect(source).toContain("this.ui.addChild(this.#layout.topFill)");
		expect(source).toContain("this.ui.addChild(this.#layout.bottomFill)");
		expect(source).toContain("this.ui.onFrameComposed = () => this.#layout.onFrameComposed()");
		expect(source).not.toContain("#syncBottomFill");
		expect(source).not.toContain("#homeAnchorActive");
		expect(source).not.toContain("#topFill:");
		expect(source).not.toContain("#bottomFill:");
	});
});

describe("HomeAnchorLayout.sync — conversation slack routing", () => {
	/** The core of the bottom-hugging fix: once a conversation exists, ALL the
	 * anchor slack moves ABOVE the transcript. The old between-content fill
	 * painted the prompt at the top and the loader at the bottom with a void of
	 * blank rows between them; when the reply landed those rows overflowed the
	 * screen and pushed the prompt into scrollback while the viewport was
	 * mostly empty (user screenshots, 2026-07-22). */
	test("with a conversation started, all slack goes above so content hugs the composer", () => {
		const { layout } = makeHarness({ rows: 30, contentRows: 8, transcriptChildren: 1 });
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(22);
		expect(rowsOf(layout.bottomFill)).toBe(0);
	});

	/** The hero split wins while the hero is still up even if a transcript
	 * child raced in — the hero centring is what the user is looking at. */
	test("hero centring outranks conversation routing while the hero is mounted", () => {
		const { layout } = makeHarness({ rows: 30, contentRows: 8, transcriptChildren: 1, hasHero: true });
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(8);
		expect(rowsOf(layout.bottomFill)).toBe(14);
	});

	/** Growth shrinks the TOP fill row-for-row: content climbs from the
	 * composer upward, and nothing ever scrolls while free rows remain. */
	test("conversation growth eats the top fill row-for-row until the viewport fills", () => {
		const { layout, state, children } = makeHarness({ rows: 30, contentRows: 8, transcriptChildren: 1 });
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(22);
		children[1] = block(20);
		layout.sync(true);
		expect(rowsOf(layout.topFill)).toBe(10);
		expect(rowsOf(layout.bottomFill)).toBe(0);
		// Content exceeds the viewport: both fills are zero — the composer is
		// on the natural bottom, same place the fill held it.
		children[1] = block(31);
		layout.sync(true);
		expect(rowsOf(layout.topFill)).toBe(0);
		expect(rowsOf(layout.bottomFill)).toBe(0);
	});
});
