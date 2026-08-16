/**
 * The fullscreen transcript drill-in answers the pointer like every other
 * ModalShell card.
 *
 * WHY: the viewer was a DynamicBorder sandwich whose only pointer gesture was
 * the wheel. It painted a hand-built hint string ("Esc:close ctrl+o:expand"),
 * so the two actions it advertised could not be clicked, and a reader who
 * reached it with the mouse had no way out. It is a card now, and this suite
 * pins the class of defect a chrome rewrite reintroduces: a chrome gesture
 * that stops running its action, and — the inverse, which is how the shared
 * hit-test broke sixteen other hosts — chrome routing that swallows the wheel
 * so the body stops scrolling.
 *
 * Every case drives the real viewer over a real session file and injects real
 * SGR bytes; nothing here mocks the component under test.
 *
 * NOT COVERED: chip hover PAINT (modal-shell owns and tests the highlight),
 * the remote/collab-guest read path (its own cases in
 * agent-transcript-viewer.test.ts), and clicks on transcript body rows, which
 * are not click targets in this viewer at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentTranscriptViewer } from "@veyyon/coding-agent/modes/components/agent-transcript-viewer";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/components/chat-transcript-builder";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@veyyon/coding-agent/session/session-entries";
import type { TUI } from "@veyyon/tui";
import { removeSyncWithRetries } from "@veyyon/utils";

const WIDTH = 100;
const ROWS = 40;
const TS = new Date().toISOString();

/** A transcript long enough that the viewport scrolls. */
function buildJsonl(): string {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const lines = [
		JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
	];
	for (let i = 0; i < 120; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `a${i}`,
				parentId: null,
				timestamp: TS,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Reviewing step ${i}.` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "gpt-5.5",
					usage,
					stopReason: "stop",
					timestamp: i,
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

interface Harness {
	viewer: AgentTranscriptViewer;
	onClose: ReturnType<typeof vi.fn>;
	rows: () => string[];
}

let dirs: string[] = [];

function makeViewer(): Harness {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-pointer-"));
	dirs.push(dir);
	const file = path.join(dir, "__advisor.jsonl");
	fs.writeFileSync(file, buildJsonl());

	const agents = new AgentRegistry();
	agents.register({
		id: "Main/advisor",
		displayName: "advisor",
		kind: "advisor",
		parentId: "Main",
		session: null,
		sessionFile: file,
		status: "parked",
	});
	const onClose = vi.fn();
	const viewer = new AgentTranscriptViewer({
		agentId: "Main/advisor",
		registry: agents,
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		cwd: "/tmp",
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		requestRender: () => {},
		onClose,
		onHubClose: () => {},
	});
	return { viewer, onClose, rows: () => viewer.render(WIDTH) };
}

/** SGR left-press at 1-based screen coordinates, the way a terminal reports it. */
function click(viewer: AgentTranscriptViewer, row: number, col: number): void {
	viewer.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);
}

/** SGR wheel-up at 1-based screen coordinates. */
function wheelUp(viewer: AgentTranscriptViewer, row: number, col: number): void {
	viewer.handleInput(`\x1b[<64;${col + 1};${row + 1}M`);
}

function strip(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Screen position of the `[x]` close glyph. */
function closeGlyphAt(rows: string[]): { row: number; col: number } {
	for (let row = 0; row < rows.length; row++) {
		const col = strip(rows[row]!).indexOf("[x]");
		if (col !== -1) return { row, col: col + 1 };
	}
	throw new Error("the card drew no close glyph");
}

/** Screen position of a footer chip's label. */
function chipAt(rows: string[], label: string): { row: number; col: number } {
	for (let row = 0; row < rows.length; row++) {
		const col = strip(rows[row]!).indexOf(label);
		if (col !== -1) return { row, col };
	}
	throw new Error(`the card drew no "${label}" chip`);
}

/** First transcript row of the painted card, as text. */
function bodyText(rows: string[]): string {
	return rows.map(strip).join("\n");
}

describe("the transcript card answers the pointer", () => {
	let rowsDesc: PropertyDescriptor | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		initTheme();
		rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => ROWS, set: () => {} });
	});

	afterEach(() => {
		if (rowsDesc) {
			Object.defineProperty(process.stdout, "rows", rowsDesc);
		} else {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
		vi.restoreAllMocks();
		for (const dir of dirs) removeSyncWithRetries(dir);
		dirs = [];
	});

	it("closes when the close glyph is clicked", () => {
		const { viewer, onClose, rows } = makeViewer();
		const glyph = closeGlyphAt(rows());

		click(viewer, glyph.row, glyph.col);

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes when the close chip is clicked", () => {
		const { viewer, onClose, rows } = makeViewer();
		const chip = chipAt(rows(), "close");

		click(viewer, chip.row, chip.col);

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes when the click lands outside the card", () => {
		const { viewer, onClose, rows } = makeViewer();
		// A card hit-tests against the geometry of its LAST paint.
		rows();

		click(viewer, 0, 0);

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("toggles expansion when the expand chip is clicked, and back on a second click", () => {
		const setExpanded = vi.spyOn(ChatTranscriptBuilder.prototype, "setExpanded");
		const { viewer, onClose, rows } = makeViewer();
		const chip = chipAt(rows(), "expand");

		click(viewer, chip.row, chip.col);
		rows();
		click(viewer, chip.row, chip.col);

		expect(setExpanded.mock.calls.map(c => c[0])).toEqual([true, false]);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("still scrolls the body on the wheel, and does not close", () => {
		const { viewer, onClose, rows } = makeViewer();
		const before = bodyText(rows());
		const middle = Math.floor(ROWS / 2);

		wheelUp(viewer, middle, Math.floor(WIDTH / 2));
		const after = bodyText(rows());

		// The tail follows the bottom until the reader scrolls; a wheel up must
		// move the window off it.
		expect(after).not.toBe(before);
		expect(after).toContain("Reviewing step");
		expect(onClose).not.toHaveBeenCalled();
	});

	it("leaves the viewer alone for a click on a transcript row", () => {
		const { viewer, onClose, rows } = makeViewer();
		const row = chipAt(rows(), "Reviewing step");

		click(viewer, row.row, row.col);

		expect(onClose).not.toHaveBeenCalled();
	});
});
