// WHY THIS SUITE EXISTS (A-HAND-PAINTED-LIST-STROBES-WHILE-THE-SHARED-ONE-FADES).
//
// The pointer band learned to fade, and it learned it inside `SelectList` — the tui list every
// picker built out of a `SelectList` inherits it for free. Ten pickers are not built that way.
// `/resume`, `/tree`, the branch-from-message card, `/history`, the extension ask dialog, the copy
// picker, the reset-usage picker, `/move`'s path picker, the hook selector and the MCP add wizard
// paint their own rows, hold their own hovered index, and called `selectionBand` the frame a motion
// report arrived. So half the product cross-faded and half of it strobed, at whatever rate the
// terminal coalesces motion reports, and which half you got depended on which card you opened.
// (Every one after the first four was found by walking the table below and asking which surface
// hit-tests its own rows and is missing from it. That question is the cheapest way to find the
// next one, and it has now found six.)
//
// The last two also fixed a second defect the table found: a card whose host hands the repaint in
// through the CONSTRUCTOR rather than through `setOnRequestRender` built no fade at all, so the
// seam existed and the real host never reached it. `lend()` below drives whichever seam the card's
// own host drives, which is why a pane may pass the callback to `make`.
//
// This suite pins the contract each of those ten now owes, and it pins it at both ends:
//
//   1. The band ARRIVES. The frame the report lands on paints no band at all, and the strength
//      climbs from there. A list that switches the band on is the defect this closes.
//   2. It lands on the band that list always painted. The end of a fade-in is the exact byte
//      sequence the switched band produced, proven against a twin pane with no motion lent to it
//      rather than against a hardcoded escape — if the endpoint drifts, the fade did not add
//      motion, it changed the theme.
//   3. Two rows band at once. The row the pointer left is still on its way out while the row it
//      arrived at is on its way in, which is the whole reason strength is per ROW and not one
//      "current" value.
//   4. The selected row never bands from the pointer. It owns its own styling and a second full
//      band reads as two selections.
//   5. A card with no repaint lent to it is switched, exactly as it was before. Every existing
//      direct construction — and every existing test — depends on that.
//   6. It terminates. The fade settles, the clock empties, the card stops asking for frames, and a
//      disposed card forgets the pointer instead of leaving a band and a live animation behind.
//
// The panes are enumerated by hand because each has its own constructor surface (a session list, a
// message tree, a branch list, a SQLite-backed history search, an extension question, a copy tree,
// an account list, a directory listing) and no runtime registry names them. WHAT THIS DOES NOT
// CATCH: a NINTH hand-painted list added later, or a pointer surface inside a composite card that
// hit-tests for it (the extensions dashboard is one, fenced in its own suite). Either inherits
// nothing and would sit outside this table. The shared helper case below is the
// fence that makes such a list cheap to bring in — `hoverBandAt` is the only way to paint a fading
// band, and its full strength is asserted to be `selectionBand` itself, so adopting it can never
// change how a settled row looks. The eye-level question (does the fade read as motion?) is a
// render proof's job, not an assertion's.
//
// Colour is forced ON and the theme is built in truecolor: `theme.bg` returns its argument
// unchanged when colour is off, and a 256-colour theme is handed the switched band by design, so
// under the default piped policy every band here would be byte-identical to a bare row and no
// assertion could tell them apart.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import type { AgentMessage } from "@veyyon/agent-core";
import { AskDialogComponent } from "@veyyon/coding-agent/modes/components/ask-dialog";
import { CopySelectorComponent } from "@veyyon/coding-agent/modes/components/copy-selector";
import { HistorySearchComponent } from "@veyyon/coding-agent/modes/components/history-search";
import { HookSelectorComponent } from "@veyyon/coding-agent/modes/components/hook-selector";
import { MCPAddWizard } from "@veyyon/coding-agent/modes/components/mcp-add-wizard";
import { modalRevealGround } from "@veyyon/coding-agent/modes/components/modal-shell";
import { MoveOverlay } from "@veyyon/coding-agent/modes/components/move-overlay";
import { ResetUsageSelectorComponent } from "@veyyon/coding-agent/modes/components/reset-usage-selector";
import { hoverBandAt, selectionBand } from "@veyyon/coding-agent/modes/components/selector-helpers";
import { SessionSelectorComponent } from "@veyyon/coding-agent/modes/components/session-selector";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/components/tree-selector";
import { UserMessageSelectorComponent } from "@veyyon/coding-agent/modes/components/user-message-selector";
import { getThemeByName, initTheme, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { HistoryEntry, HistoryStorage } from "@veyyon/coding-agent/session/history-storage";
import type { SessionEntry, SessionTreeNode } from "@veyyon/coding-agent/session/session-entries";
import type { SessionInfo } from "@veyyon/coding-agent/session/session-listing";
import { type AnsiPolicy, getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 110;
const FRAME = 1000 / 60;
/** MOTION.hover is 90ms; 30 frames is half a second, so a settle loop that runs is a hang. */
const SETTLE_FRAMES = 30;

/** The card's own repaint gate is `TERMINAL.trueColor`, probed once at load from a real terminal. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;
let originalTrueColor: boolean;
let originalColorterm: string | undefined;
let clockNow = 0;
let clockAnchored = false;

/**
 * Advance the shared clock by `ms`. The panes take the production clock (their hosts hand them a
 * repaint, not a clock), so the frames are driven through its public `tick` rather than by waiting.
 *
 * The anchor is re-taken every time the ticker restarts. A clock that runs dry forgets its last
 * frame time and re-bases on the real wall clock when the next animation registers, so a harness
 * that kept counting from its own first anchor would hand the next fade a delta of everything it
 * had already spent — clamped to one stalled frame, which lands a 90ms fade in a single step and
 * reads as "the band was never mid-travel".
 */
function advance(ms: number): void {
	if (!clockAnchored) {
		clockNow = performance.now();
		clockAnchored = true;
	}
	clockNow += ms;
	motionClock.tick(clockNow);
	if (motionClock.liveCount === 0) clockAnchored = false;
}

/** Run frames until nothing is animating. Returns the frames it took. */
function settle(): number {
	for (let frame = 1; frame <= SETTLE_FRAMES; frame++) {
		advance(FRAME);
		if (motionClock.liveCount === 0) return frame;
	}
	throw new Error(`hover fade still live after ${SETTLE_FRAMES} frames`);
}

/** `48;2;r;g;b` from a rendered row, or null when the row paints no truecolor background. */
function bandRgb(row: string): [number, number, number] | null {
	const match = /\x1b\[[0-9;]*?48;2;(\d+);(\d+);(\d+)/.exec(row);
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hexRgb(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

/** How far one colour is from another, summed over the channels. */
function distance(a: [number, number, number], b: [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** SGR motion report (button 32+3=35) at a 1-based screen row, mid-card column. */
function motionAt(row1: number, col1 = 40): string {
	return `\x1b[<35;${col1};${row1}M`;
}

/** The panes share only this much surface, and it is all the cases below touch. */
interface Pane {
	render(width: number): readonly string[];
	handleInput(data: string): void;
	/** Cards whose host lends the repaint at construction time have no setter; see {@link lend}. */
	setOnRequestRender?: (cb: () => void) => void;
	dispose(): void;
}

interface PaneCase {
	readonly name: string;
	/**
	 * A fresh card, mounted at nothing. `requestRender` is handed in the way this card's real host
	 * hands it in; a case that means "no host lent a repaint" calls this with nothing.
	 */
	make(requestRender?: () => void): Pane;
	/** Two rows the pointer visits, and the row that is already selected. Neither visited row is. */
	readonly first: string;
	readonly second: string;
	readonly selected: string;
}

/**
 * A card with the repaint lent through the seam its own host uses, and only that one. A case that
 * declares a parameter on `make` stands for a host that hands the callback to the CONSTRUCTOR, so
 * the card has to build its fade there; lending it a second time through the setter would paper
 * over exactly the defect this table found.
 */
function lend(paneCase: PaneCase, cb: () => void): Pane {
	if (paneCase.make.length > 0) return paneCase.make(cb);
	const pane = paneCase.make();
	pane.setOnRequestRender?.(cb);
	return pane;
}

const NOW = Math.floor(Date.parse("2026-08-10T12:00:00.000Z") / 1000);

function makeSession(id: string, title: string): SessionInfo {
	return {
		path: `/work/${id}.jsonl`,
		id,
		cwd: "/work",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: `body for ${id}`,
		allMessagesText: `body for ${id}`,
	};
}

let treeCounter = 0;
function userNode(text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${treeCounter++}`;
	const message: AgentMessage = { role: "user", content: text, timestamp: treeCounter };
	const entry: SessionEntry = { type: "message", id, parentId, timestamp: "2026-08-10T12:00:00.000Z", message };
	return { entry, children: [] };
}

function historyStorage(prompts: string[]): HistoryStorage {
	const entries: HistoryEntry[] = prompts.map((prompt, index) => ({
		id: index + 1,
		prompt,
		cwd: "/repo",
		sessionId: "s-1",
		created_at: NOW - index * 900,
	}));
	// The card reads recents and searches; the real storage is a SQLite handle this suite has no use
	// for, and constructing one would test the database rather than the band.
	const storage = { getRecent: () => entries, search: () => entries } as unknown as HistoryStorage;
	return storage;
}

/**
 * The `/move` card lists real directories, so its rows come from a real tree. Three sibling
 * directories, named so the card's alphabetical order is the order the cases assume.
 */
const moveCwd = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-band-move-"));
for (const name of ["alpha", "beta", "gamma"]) fs.mkdirSync(path.join(moveCwd, name));

const PANES: readonly PaneCase[] = [
	{
		name: "the resume-session picker",
		make: () =>
			new SessionSelectorComponent(
				[
					makeSession("aaaa", "Alpha session"),
					makeSession("bbbb", "Beta session"),
					makeSession("cccc", "Gamma session"),
				],
				() => {},
				() => {},
				() => {},
				{ getTerminalRows: () => 40, fillHeight: true },
			),
		first: "Beta session",
		second: "Gamma session",
		selected: "Alpha session",
	},
	{
		name: "the session tree card",
		make: () => {
			const first = userNode("alpha the first prompt");
			const second = userNode("bravo the second prompt", first.entry.id);
			first.children.push(second);
			const third = userNode("charlie the third prompt", second.entry.id);
			second.children.push(third);
			return new TreeSelectorComponent(
				[first],
				third.entry.id,
				() => {},
				() => {},
			);
		},
		first: "alpha the first prompt",
		second: "bravo the second prompt",
		selected: "charlie the third prompt",
	},
	{
		name: "the branch-from-message card",
		make: () =>
			new UserMessageSelectorComponent(
				[
					{ id: "m1", text: "the first user message" },
					{ id: "m2", text: "the second user message" },
					{ id: "m3", text: "the third user message" },
				],
				() => {},
				() => {},
			),
		first: "the first user message",
		second: "the second user message",
		selected: "the third user message",
	},
	{
		name: "the history search card",
		make: () =>
			new HistorySearchComponent(
				historyStorage(["first prompt", "second prompt", "third prompt"]),
				() => {},
				() => {},
			),
		first: "second prompt",
		second: "third prompt",
		selected: "first prompt",
	},
	{
		name: "the extension ask dialog",
		make: () =>
			new AskDialogComponent(
				[
					{
						id: "q1",
						question: "Which backend?",
						options: [
							{ label: "the sqlite backend" },
							{ label: "the postgres backend" },
							{ label: "the memory backend" },
						],
					},
				],
				{ onSubmit: () => {}, onCancel: () => {}, onPrompt: async () => undefined },
			),
		first: "the postgres backend",
		second: "the memory backend",
		selected: "the sqlite backend",
	},
	{
		name: "the copy picker",
		make: () =>
			new CopySelectorComponent(
				[
					{ id: "c1", label: "the first reply", preview: "one", content: "one" },
					{ id: "c2", label: "the second reply", preview: "two", content: "two" },
					{ id: "c3", label: "the third reply", preview: "three", content: "three" },
				],
				{ onPick: () => {}, onCancel: () => {} },
			),
		first: "the second reply",
		second: "the third reply",
		selected: "the first reply",
	},
	{
		name: "the reset-usage picker",
		make: () =>
			new ResetUsageSelectorComponent(
				[
					{ label: "first account", availableCount: 0, active: false, target: { credentialId: 1 } },
					{ label: "second account", availableCount: 2, active: false, target: { credentialId: 2 } },
					{ label: "third account", availableCount: 3, active: false, target: { credentialId: 3 } },
				],
				() => {},
				() => {},
			),
		// The card selects the first REDEEMABLE account, so the one with no resets left is free
		// for the pointer and the second is the row that owns its own styling.
		first: "first account",
		second: "third account",
		selected: "second account",
	},
	{
		name: "the move path picker",
		make: () => new MoveOverlay(moveCwd, () => {}),
		first: "beta",
		second: "gamma",
		selected: "alpha",
	},
	{
		// The extension/hook dialog: its host hands the repaint in through the CONSTRUCTOR options,
		// which is why this pane passes `onRequestRender` there rather than only through the setter.
		name: "the hook selector",
		make: requestRender =>
			new HookSelectorComponent(
				"Pick a hook",
				["the first hook", "the second hook", "the third hook"],
				() => {},
				() => {},
				{ initialIndex: 2, onRequestRender: requestRender },
			),
		first: "the first hook",
		second: "the second hook",
		selected: "the third hook",
	},
	{
		// The MCP add wizard on its transport step; the name step is a text field with no rows.
		// Its host passes the repaint as a constructor argument too.
		name: "the mcp add wizard",
		make: requestRender =>
			new MCPAddWizard(
				async () => {},
				() => {},
				undefined,
				undefined,
				requestRender,
				"a-server",
			),
		first: "http (HTTP server)",
		second: "sse (Server-Sent Events)",
		selected: "stdio (Local process)",
	},
];

/**
 * 1-based screen row of the first rendered line whose CELLS contain `text`.
 *
 * Matched against the stripped row rather than the bytes, because a rendered row's label is not a
 * contiguous byte run and never was: `SelectList.#paintHits` interleaves a `matchHighlight` escape
 * around every filter-hit character, and the selection band is a gradient whose span boundaries
 * fall wherever the ramp says. Nothing in the product looks a row up by its rendered bytes — hit
 * testing is column arithmetic — so the reader is what was wrong here, not the paint.
 */
function rowOf(pane: Pane, text: string): number {
	const lines = pane.render(WIDTH);
	const index = lines.findIndex(line => util.stripVTControlCharacters(line).includes(text));
	expect(index, `row containing ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** The rendered row, escapes and all — the bytes are the subject here. */
function rowText(pane: Pane, row: number): string {
	const line = pane.render(WIDTH)[row - 1];
	if (line === undefined) throw new Error(`no row ${row} in a ${WIDTH}-column frame`);
	return line;
}

/** A pane with the pointer parked on `text` and no repaint lent: the switched band. */
function switchedBandRow(paneCase: PaneCase, text: string): string {
	const twin = paneCase.make();
	const row = rowOf(twin, text);
	twin.handleInput(motionAt(row));
	const painted = rowText(twin, row);
	twin.dispose();
	return painted;
}

beforeEach(async () => {
	await initTheme(false);
	// The mix is a truecolor computation, and the theme's mode is fixed at construction from the
	// environment: a suite that trusts the CI terminal's own capability silently asserts the
	// 256-colour branch instead, which is how a band test stays green while the band is broken.
	originalColorterm = Bun.env.COLORTERM;
	Bun.env.COLORTERM = "truecolor";
	const loaded = await getThemeByName("titanium");
	if (!loaded) throw new Error("titanium theme unavailable in test env");
	if (loaded.getColorMode() !== "truecolor") throw new Error(`titanium built as ${loaded.getColorMode()}`);
	setThemeInstance(loaded);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	originalTrueColor = terminalCaps.trueColor;
	terminalCaps.trueColor = true;
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
	clockAnchored = false;
});

afterEach(() => {
	motionClock.clear();
	setAnsiPolicy(policy);
	terminalCaps.trueColor = originalTrueColor;
	geometry.restore();
	if (originalColorterm === undefined) delete Bun.env.COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
});

describe("a pointer band fades on a hand-painted list", () => {
	it("full strength is the switched band, byte for byte", () => {
		// The one fence a fifth hand-painted list inherits: adopting the fading band cannot change
		// what a settled row looks like, because the settled row IS the band that was there.
		expect(hoverBandAt("a session row", 40, 1)).toBe(selectionBand("a session row", 40));
		expect(hoverBandAt("a session row", 40, 0.4)).not.toBe(selectionBand("a session row", 40));
	});

	for (const paneCase of PANES) {
		describe(paneCase.name, () => {
			it("arrives over frames and lands on the band it always painted", () => {
				let renders = 0;
				const pane = lend(paneCase, () => {
					renders += 1;
				});
				const row = rowOf(pane, paneCase.first);
				const bare = rowText(pane, row);
				// Absolute, not relative to another frame of the same build: strength 0 is the ABSENCE of
				// a band. A band "mixed all the way out" is still an explicit fill on every row of the
				// list, which is invisible on a black terminal and a slab on a grey one — and a frame
				// compared only against another frame that also carries it cannot see that at all.
				expect(bandRgb(bare), "a row nobody points at carries no fill").toBeNull();

				pane.handleInput(motionAt(row));
				expect(renders).toBeGreaterThan(0);
				// The frame the report lands on: the band has not arrived yet, so the row is untouched.
				expect(rowText(pane, row)).toBe(bare);
				expect(bandRgb(rowText(pane, row)), "no fill on the frame the report arrives").toBeNull();

				advance(15);
				const midway = bandRgb(rowText(pane, row));
				expect(midway, "a band mid-fade").not.toBeNull();

				settle();
				const switched = switchedBandRow(paneCase, paneCase.first);
				expect(rowText(pane, row)).toBe(switched);

				const full = bandRgb(switched);
				expect(full, "the switched band paints a truecolor background").not.toBeNull();
				const ground = hexRgb(modalRevealGround());
				// Mid-fade is neither endpoint: a colour mixed out of the ground the card sits on.
				expect(distance(midway as [number, number, number], full as [number, number, number])).toBeGreaterThan(0);
				expect(distance(midway as [number, number, number], ground)).toBeGreaterThan(0);
				pane.dispose();
			});

			it("keeps the row the pointer left banding while the new row arrives", () => {
				const pane = lend(paneCase, () => {});
				const leaving = rowOf(pane, paneCase.first);
				const arriving = rowOf(pane, paneCase.second);
				const bareLeaving = rowText(pane, leaving);

				pane.handleInput(motionAt(leaving));
				settle();
				pane.handleInput(motionAt(arriving));
				advance(15);

				const outgoing = bandRgb(rowText(pane, leaving));
				const incoming = bandRgb(rowText(pane, arriving));
				expect(outgoing, "the row the pointer left still bands").not.toBeNull();
				expect(incoming, "the row the pointer arrived at bands").not.toBeNull();
				const full = bandRgb(switchedBandRow(paneCase, paneCase.second));
				// Both are mid-travel: one on its way out, one on its way in, on the same frame.
				expect(distance(outgoing as [number, number, number], full as [number, number, number])).toBeGreaterThan(0);
				expect(distance(incoming as [number, number, number], full as [number, number, number])).toBeGreaterThan(0);

				settle();
				expect(rowText(pane, leaving)).toBe(bareLeaving);
				expect(rowText(pane, arriving)).toBe(switchedBandRow(paneCase, paneCase.second));
				pane.dispose();
			});

			it("never bands the selected row", () => {
				const pane = lend(paneCase, () => {});
				const row = rowOf(pane, paneCase.selected);
				const before = rowText(pane, row);

				pane.handleInput(motionAt(row));
				expect(rowText(pane, row)).toBe(before);
				advance(15);
				expect(rowText(pane, row)).toBe(before);
				advance(FRAME * 10);
				expect(rowText(pane, row)).toBe(before);
				pane.dispose();
			});

			it("paints the switched band when no host lends a repaint", () => {
				const pane = paneCase.make();
				const row = rowOf(pane, paneCase.first);
				const bare = rowText(pane, row);

				pane.handleInput(motionAt(row));
				const painted = rowText(pane, row);
				expect(painted).not.toBe(bare);
				expect(painted).toBe(switchedBandRow(paneCase, paneCase.first));
				// Nothing animating: an unwired list registers no fade at all, so no frame of it exists
				// to be dropped and the shared clock never wakes for it.
				expect(motionClock.liveCount).toBe(0);
				expect(rowText(pane, row)).toBe(painted);
				pane.dispose();
			});

			it("settles, stops asking for frames, and drops the band when disposed", () => {
				let renders = 0;
				const pane = lend(paneCase, () => {
					renders += 1;
				});
				const row = rowOf(pane, paneCase.first);
				const bare = rowText(pane, row);

				pane.handleInput(motionAt(row));
				const frames = settle();
				expect(frames).toBeGreaterThan(1);
				expect(motionClock.liveCount).toBe(0);

				const settledRenders = renders;
				for (let frame = 0; frame < 5; frame++) advance(FRAME);
				expect(renders).toBe(settledRenders);

				pane.dispose();
				expect(rowText(pane, row)).toBe(bare);
				expect(motionClock.liveCount).toBe(0);
			});
		});
	}
});
