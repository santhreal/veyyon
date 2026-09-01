/**
 * HomeAnchorLayout — the home-screen anchor extracted from interactive-mode
 * (ARCH-2, layout slice). These tests exist because the anchor math was
 * previously untestable inside the god-file: a regression in the slack split
 * or the re-anchor rule shows up only as a composer drifting off the viewport
 * bottom or bouncing mid-stream, which no static check catches. Each rule
 * (2/5 optical centring, stateless re-anchor with no permanent latch-off,
 * live-children measurement in both directions, same-frame dismissal math) is
 * pinned here with exact row counts.
 *
 * The row counts are the point: a fill sized one row wrong is a frame composed
 * one row past the viewport (which moves the window) or one row short of it
 * (which lifts the composer off the bottom edge), and both were repaired by a
 * second paint that put the same rows somewhere else — the shake, once per row
 * of a streaming answer. There is no second paint now, so every number here is
 * the number that reaches the terminal.
 */
import { describe, expect, test } from "bun:test";
import type { Component, TUI } from "@veyyon/tui";
import { HomeAnchorLayout, type HomeAnchorPort } from "../../../src/modes/terminal/controllers/home-anchor-layout";

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
		layoutSized: [] as Component[],
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
		// The layout registers both fills so a component-scoped frame renders
		// them instead of reusing the previous frame's rows.
		markLayoutSized: (component: Component) => {
			state.layoutSized.push(component);
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

	test("the live children outrank the composed frame in both directions", () => {
		// The frame is a frame behind, and which way it is wrong depends only on
		// which way the content moved since it composed. Growth (10 live rows
		// against a 2-row frame) sized from the frame reserves 28 rows of slack
		// on top of 10 rows of content and composes 38 rows into a 30-row
		// viewport; a collapse (4 live rows against a 26-row frame) sized from
		// the frame leaves the composer 22 rows above the bottom edge. Both are
		// sized from the children instead.
		const grown = makeHarness({ rows: 30, contentRows: 10, composedFrameRows: 2 });
		grown.layout.sync();
		expect(rowsOf(grown.layout.bottomFill)).toBe(20);

		const collapsed = makeHarness({ rows: 30, contentRows: 4, composedFrameRows: 26 });
		collapsed.layout.sync();
		expect(rowsOf(collapsed.layout.bottomFill)).toBe(26);
	});

	test("both fills are registered as layout-sized, so a partial frame renders them", () => {
		// The sizing pass runs at the top of a frame that requested nothing on
		// the fills' behalf. A component-scoped frame reuses the previous rows of
		// every root child it was not asked to repaint, so an unregistered fill
		// composes at the height the PREVIOUS frame's content called for — one
		// row of overflow per streamed row, and nothing downstream to repair it.
		const { layout, state } = makeHarness({ rows: 30, contentRows: 8 });
		expect(state.layoutSized).toEqual([layout.topFill, layout.bottomFill]);
	});

	test("a scrollback-driven child is measured through its bounded path, never its frame render", () => {
		// The rule is on the interface, not on one class. `render()` on a child
		// the engine drives with the native-scrollback protocol is not a read: it
		// hands the engine's committed prefix to the terminal and reports the rows
		// it dropped, and the engine authorizes exactly one such drop per frame —
		// count fed, child rendered, report read back. It also republishes that
		// count after every emit, so a sizing pass calling render() spends the
		// drop on a frame of its own and the compose render drops a second prefix
		// against the same count. Measured on the scrolled 24-row arm of the
		// blank-band simulation: the transcript's frame went to zero rows and the
		// conversation left the screen. Any child carrying that protocol must be
		// measured through the state-isolated tail instead.
		const calls = { render: 0, tail: [] as number[] };
		const driven = {
			render: (): readonly string[] => {
				calls.render++;
				return Array.from({ length: 12 }, () => "");
			},
			setNativeScrollbackCommittedRows: () => {},
			renderViewportTail: (_width: number, maxRows: number): readonly string[] => {
				calls.tail.push(maxRows);
				return Array.from({ length: Math.min(12, maxRows) }, () => "");
			},
		};
		const { layout, children } = makeHarness({ rows: 30, contentRows: 8 });
		children.splice(1, 0, driven);

		layout.sync();

		// 8 rows of block plus 12 of transcript leaves 10 of slack, and the
		// transcript was asked for the rows the viewport still had.
		expect({ render: calls.render, tail: calls.tail, bottom: rowsOf(layout.bottomFill) }).toEqual({
			render: 0,
			tail: [30],
			bottom: 10,
		});
	});

	test("the measurement saturates at the viewport, so a long transcript routes no slack", () => {
		// The bounded path returns at most the rows asked for, so content past
		// the viewport reads as exactly the viewport — which is all the routing
		// needs, and is what keeps a scrolled session from reading as slack.
		const tail: number[] = [];
		const driven = {
			render: (): readonly string[] => Array.from({ length: 400 }, () => ""),
			setNativeScrollbackCommittedRows: () => {},
			renderViewportTail: (_width: number, maxRows: number): readonly string[] => {
				tail.push(maxRows);
				return Array.from({ length: maxRows }, () => "");
			},
		};
		const { layout, children } = makeHarness({ rows: 20, contentRows: 4, transcriptChildren: 3 });
		children.splice(1, 0, driven);

		layout.sync();

		expect({ tail, top: rowsOf(layout.topFill), bottom: rowsOf(layout.bottomFill) }).toEqual({
			tail: [20],
			top: 0,
			bottom: 0,
		});
	});
});

describe("HomeAnchorLayout — stateless re-anchor, no latch-off", () => {
	test("fills collapse while the conversation fills the viewport, and re-anchor when slack returns", () => {
		// The 2026-07-23 glitch: a transient tall frame (a streaming preview
		// spike) latched the anchor off for good, then the collapse left the
		// composer stranded mid-screen above a blank slab. The anchor is
		// stateless now: fills vanish at slack zero and return the moment the
		// frame shrinks, so the composer hugs the bottom in every state.
		const { layout, children } = makeHarness({
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
		children[1] = block(12);
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(8);
		expect(rowsOf(layout.bottomFill)).toBe(0);
	});

	test("an overflowing home screen keeps anchoring once rows free up", () => {
		// A tiny terminal where the welcome card fills every row: fills are
		// zero while there is no slack, and return the moment there is — the
		// anchor never disengages permanently.
		const { layout, children } = makeHarness({
			rows: 10,
			contentRows: 15,
			composedFrameRows: 15,
			transcriptChildren: 0,
			hasHero: true,
		});
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(0);
		children[1] = block(4);
		layout.sync();
		// Hero centring: 2/5 of the 6 slack rows above, the rest below.
		expect(rowsOf(layout.topFill)).toBe(2);
		expect(rowsOf(layout.bottomFill)).toBe(4);
	});
});

describe("HomeAnchorLayout.sync — one pass, no follow-up paint", () => {
	/**
	 * What replaced the post-commit correction. That correction re-sized the
	 * fills against the frame that had just composed and requested a repaint
	 * whenever they moved, which is a second paint of the same content per
	 * change — and, while an answer streamed, one per row of it. Sizing from the
	 * live children makes the first paint the right one, so the property to pin
	 * is that a second sync against the same children changes nothing and asks
	 * for nothing.
	 */
	test("a second sync over unchanged children is a no-op and requests no paint", () => {
		const { layout, state } = makeHarness({ rows: 30, contentRows: 8, transcriptChildren: 1 });
		layout.sync();
		expect({ top: rowsOf(layout.topFill), bottom: rowsOf(layout.bottomFill) }).toEqual({ top: 22, bottom: 0 });
		layout.sync();
		expect({ top: rowsOf(layout.topFill), bottom: rowsOf(layout.bottomFill) }).toEqual({ top: 22, bottom: 0 });
		expect(state.renderRequests).toBe(0);
	});

	test("content that changes height is placed by the next sync, not the one after it", () => {
		// The streaming step, in both directions. Each sync is the pass at the
		// top of one frame: the fill it computes is the fill that frame paints,
		// so the content plus the fill is exactly a viewport every time.
		const { layout, children } = makeHarness({ rows: 30, contentRows: 8, transcriptChildren: 1 });
		for (const contentRows of [8, 9, 10, 24, 12, 3, 29]) {
			children[1] = block(contentRows);
			layout.sync();
			const total = contentRows + rowsOf(layout.topFill) + rowsOf(layout.bottomFill);
			expect({ contentRows, total }).toEqual({ contentRows, total: 30 });
		}
		// And past the viewport there is nothing left to route.
		children[1] = block(31);
		layout.sync();
		expect({ top: rowsOf(layout.topFill), bottom: rowsOf(layout.bottomFill) }).toEqual({ top: 0, bottom: 0 });
	});
});

describe("HomeAnchorLayout.onHeroDismissed — same-frame re-anchor", () => {
	test("re-anchors from the live children on this frame, not the next", () => {
		// Hero centred on a 30-row terminal: top 8, bottom 14, content 8 (of
		// which the hero block is 6). Dismissal unmounts the hero BEFORE the
		// layout callback runs, so the walk sees the surviving 2 content rows
		// and the bottom fill becomes 28 to keep the composer on the bottom edge
		// without waiting for the next compose.
		const { layout, state, children } = makeHarness({ rows: 30, contentRows: 8, hasHero: true });
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(8);
		expect(rowsOf(layout.bottomFill)).toBe(14);
		state.hasHero = false;
		children[1] = block(2);
		layout.onHeroDismissed(14);
		expect(rowsOf(layout.topFill)).toBe(0);
		expect(rowsOf(layout.bottomFill)).toBe(28);
		expect(state.renderRequests).toBe(1);
	});

	test("re-anchors on a dismissal that lands before the first paint", () => {
		// A keystroke racing startup: no frame has composed, and the sizing pass
		// needs none — it reads the children that are mounted.
		const { layout, state } = makeHarness({ rows: 30, contentRows: 8, hasHero: false });
		layout.onHeroDismissed(5);
		expect(rowsOf(layout.bottomFill)).toBe(22);
		expect(state.renderRequests).toBe(1);
	});
});

describe("HomeAnchorLayout.sync — conversation slack routing", () => {
	/** The core of the bottom-hugging fix: once a conversation exists, ALL the
	 * anchor slack moves ABOVE the transcript. The old between-content fill
	 * painted the prompt at the top and the loader at the bottom with a void of
	 * blank rows between them; when the reply landed those rows overflowed the
	 * screen and pushed the prompt into scrollback while the viewport was mostly
	 * empty. */
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
		const { layout, children } = makeHarness({ rows: 30, contentRows: 8, transcriptChildren: 1 });
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(22);
		children[1] = block(20);
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(10);
		expect(rowsOf(layout.bottomFill)).toBe(0);
		// Content exceeds the viewport: both fills are zero — the composer is
		// on the natural bottom, same place the fill held it.
		children[1] = block(31);
		layout.sync();
		expect(rowsOf(layout.topFill)).toBe(0);
		expect(rowsOf(layout.bottomFill)).toBe(0);
	});
});

describe("HomeAnchorLayout — the anchor never routes slack the children have taken", () => {
	/**
	 * THE DEFECT. Sending a message made the composer jump and the screen
	 * oscillate while the answer streamed. The fill was sized from
	 * `composedFrameRows`, which is one frame old, so a transcript child mounted
	 * since that frame was not counted: the slack routed above it was sized for
	 * rows the content had already taken, the frame composed past the viewport,
	 * and the engine scrolled the window to fit and back again.
	 *
	 * THE CLASS. Not "submit overflows". Any content whose height differs from
	 * the last composed frame's, in either direction — every `#mountChatChild`
	 * call in `interactive-mode.ts`, every streamed chunk, every card that
	 * collapses when its result lands.
	 *
	 * THE RULE. The routed fill is exactly the viewport minus what the live
	 * children render, so the frame the fill is part of is exactly a viewport
	 * tall while any slack remains. Over-filling scrolls the window;
	 * under-filling lifts the composer off the bottom edge. Neither is repaired
	 * afterwards, because a repair is a second paint of the same content.
	 *
	 * WHAT IT DOES NOT CATCH. Whether the frame the engine composes from these
	 * fills honors them: a component-scoped frame reuses a root child's previous
	 * rows, which is a property of the compositor and is swept in
	 * `no-frame-composes-past-the-viewport-while-slack-remains.test.ts` under both
	 * frame shapes. A child whose `render(width)` disagrees with itself between
	 * the sizing pass and the compose is out of reach here too.
	 */
	test("a child mounted since the composed frame is counted, not treated as free slack", () => {
		// The frame composed at 30 rows: 8 of content under 22 of top fill. A
		// chat child mounts 6 more rows and syncs before any frame contains it.
		const { layout, children } = makeHarness({
			rows: 30,
			contentRows: 8,
			composedFrameRows: 30,
			transcriptChildren: 1,
		});
		layout.topFill.setLines(22);
		children[1] = block(14);
		layout.sync();
		// 30 - 14 = 16. The frame on screen implies 22, which composes 36 rows
		// into a 30-row viewport.
		expect(rowsOf(layout.topFill)).toBe(16);
		expect(rowsOf(layout.bottomFill)).toBe(0);
	});

	test("no reachable content height routes a fill that overflows the viewport", () => {
		// The mount arm swept across every content height around the viewport
		// edge, with the stale frame frozen at the pre-mount height throughout.
		const rows = 30;
		for (let content = 1; content <= 40; content++) {
			const { layout, children } = makeHarness({
				rows,
				contentRows: content,
				composedFrameRows: 12,
				transcriptChildren: 1,
			});
			children[1] = block(content);
			layout.sync();
			const composed = content + rowsOf(layout.topFill) + rowsOf(layout.bottomFill);
			expect({ content, overflowed: composed > Math.max(content, rows) }).toEqual({ content, overflowed: false });
		}
	});
});
