/**
 * WHY: `TerminalPresentationDriver` is the terminal's whole implementation of
 * `PresentationContext`, and the defect class it guards is a view-model that
 * reaches the driver and paints nothing, paints twice, or paints stale rows:
 * a block kind with no rows, an `updateTranscriptBlock` that appends instead of
 * patching, a `setTranscriptBlocks` that leaves the previous transcript mounted,
 * a theme change that keeps the old palette's escapes in a cached row.
 *
 * The driver is driven end to end against a real `TUI` on a real VT — Ghostty's
 * parser through `VirtualTerminal` — so an assertion reads what a terminal would
 * actually display, not what a component returned. The block-kind sweep is
 * derived from `TRANSCRIPT_BLOCK_KINDS`, the run-time table `@veyyon/wire` locks
 * against its own union, so a new block kind fails here until it has rows.
 *
 * What it does NOT catch: colour fidelity on a 256-colour terminal (the encoding
 * is chosen by `@veyyon/utils/color-format` and asserted in its own suite), and
 * mouse routing, which the engine owns.
 */

import { describe, expect, test } from "bun:test";
import type { ComposerState, StatusLineState, TranscriptBlock, UIEvent } from "@veyyon/wire/presentation";
import { TRANSCRIPT_BLOCK_KINDS } from "@veyyon/wire/presentation";
import { settleFrames } from "../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { TerminalPresentationDriver } from "../../src/modes/terminal/driver";
import { testTheme as theme } from "./helpers/presentation-theme";

const WIDTH = 80;
const HEIGHT = 24;

function status(overrides: Partial<StatusLineState> = {}): StatusLineState {
	return {
		activity: "idle",
		model: "test/model-one",
		context: { used: 2_000, total: 10_000, providerReported: false },
		cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalUsd: 0 },
		workingDirectory: "~/repo",
		elapsedMs: 0,
		queuedMessages: 0,
		...overrides,
	};
}

function composer(overrides: Partial<ComposerState> = {}): ComposerState {
	return {
		mode: "input",
		text: "",
		cursorOffset: 0,
		placeholder: "Ask, or / for commands",
		attachments: [],
		queueOnSubmit: false,
		...overrides,
	};
}

/** One block per kind, so the sweep can construct every member of the union. */
function blockOfKind(kind: TranscriptBlock["kind"]): TranscriptBlock {
	const id = `block-${kind}`;
	const timestamp = 1_700_000_000_000;
	switch (kind) {
		case "user-message":
			return { kind, id, text: "USERTEXT", attachments: [], timestamp };
		case "developer-message":
			return { kind, id, text: "DEVTEXT", timestamp };
		case "assistant-message":
			return {
				kind,
				id,
				segments: [{ kind: "text", text: "ASSISTANTTEXT" }],
				model: "test/model-one",
				stopReason: "complete",
				streaming: false,
				timestamp,
			};
		case "tool-execution":
			return {
				kind,
				id,
				toolCallId: "call-1",
				toolName: "TOOLNAME",
				status: "succeeded",
				input: "TOOLINPUT",
				output: "TOOLOUTPUT",
				timestamp,
			};
		case "bash-execution":
			return { kind, id, command: "BASHCOMMAND", output: "BASHOUTPUT", exitCode: 0, cancelled: false, timestamp };
		case "python-execution":
			return { kind, id, code: "PYTHONCODE", output: "PYTHONOUTPUT", exitCode: 0, cancelled: false, timestamp };
		case "custom":
			return { kind, id, customKind: "CUSTOMKIND", text: "CUSTOMTEXT", level: "info", timestamp };
		case "hook":
			return { kind, id, hookName: "HOOKNAME", text: "HOOKTEXT", timestamp };
		case "branch-summary":
			return { kind, id, summary: "BRANCHSUMMARY", replacedCount: 3, timestamp };
		case "compaction-summary":
			return { kind, id, summary: "COMPACTIONSUMMARY", replacedCount: 5, timestamp };
		case "file-mention":
			return { kind, id, files: [{ kind: "file", name: "MENTIONEDFILE", lineCount: 2 }], timestamp };
		case "error":
			return { kind, id, message: "ERRORTEXT", recoverable: true, timestamp };
	}
}

/** The distinctive token each kind must put on screen. */
const KIND_MARKER: Record<TranscriptBlock["kind"], string> = {
	"user-message": "USERTEXT",
	"developer-message": "DEVTEXT",
	"assistant-message": "ASSISTANTTEXT",
	"tool-execution": "TOOLNAME",
	"bash-execution": "BASHCOMMAND",
	"python-execution": "PYTHONCODE",
	custom: "CUSTOMTEXT",
	hook: "HOOKTEXT",
	"branch-summary": "BRANCHSUMMARY",
	"compaction-summary": "COMPACTIONSUMMARY",
	"file-mention": "MENTIONEDFILE",
	error: "ERRORTEXT",
};

interface Rig {
	term: VirtualTerminal;
	driver: TerminalPresentationDriver;
	settle: () => Promise<void>;
	screen: () => string;
	rows: () => string[];
}

function rig(height = HEIGHT): Rig {
	const term = new VirtualTerminal(WIDTH, height, 5_000);
	const driver = new TerminalPresentationDriver(term, { theme: theme() });
	driver.tui.setScrollbackRebuild(false);
	driver.tui.setScrollIsolation(true);
	driver.start();
	const settle = () => settleFrames(term, driver.tui);
	const rows = () => term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	return { term, driver, settle, screen: () => rows().join("\n"), rows };
}

describe("every block kind reaches the screen", () => {
	test("the sweep covers exactly the union the wire package locks", () => {
		// Derived from the run-time table, not a list typed here: a new block kind
		// lands in TRANSCRIPT_BLOCK_KINDS and this fails until it has a marker.
		const locked: string[] = [...TRANSCRIPT_BLOCK_KINDS];
		expect(locked.sort()).toEqual(Object.keys(KIND_MARKER).sort());
	});

	test.each([...TRANSCRIPT_BLOCK_KINDS])("a %s block paints its own text", async kind => {
		const { driver, settle, screen } = rig();
		try {
			driver.setTranscriptBlocks([blockOfKind(kind)]);
			await settle();
			expect(screen()).toContain(KIND_MARKER[kind]);
		} finally {
			driver.stop();
		}
	});
});

describe("the three zones are on screen together", () => {
	test("transcript, status and composer all paint", async () => {
		const { driver, settle, screen } = rig();
		try {
			driver.setTranscriptBlocks([blockOfKind("user-message")]);
			driver.setStatusLine(status({ activity: "thinking", gitBranch: "BRANCHNAME" }));
			driver.setComposerState(composer({ text: "COMPOSERTEXT" }));
			await settle();
			const painted = screen();
			expect(painted).toContain("USERTEXT");
			expect(painted).toContain("thinking");
			expect(painted).toContain("test/model-one");
			expect(painted).toContain("BRANCHNAME");
			expect(painted).toContain("COMPOSERTEXT");
		} finally {
			driver.stop();
		}
	});

	test("the composer shows its placeholder only while empty", async () => {
		const { driver, settle, screen } = rig();
		try {
			driver.setComposerState(composer());
			await settle();
			expect(screen()).toContain("Ask, or / for commands");
			driver.setComposerState(composer({ text: "typed", placeholder: "" }));
			await settle();
			const painted = screen();
			expect(painted).toContain("typed");
			expect(painted).not.toContain("Ask, or / for commands");
		} finally {
			driver.stop();
		}
	});

	test("a narrow frame sheds status segments from the right and keeps the activity", async () => {
		// The narrow frame is where a segment is dropped, so it is asserted here
		// rather than inferred from the wide one.
		const term = new VirtualTerminal(24, HEIGHT, 5_000);
		const driver = new TerminalPresentationDriver(term, { theme: theme() });
		try {
			driver.start();
			driver.setStatusLine(status({ activity: "compacting", workingDirectory: "~/a/very/long/path/indeed" }));
			await settleFrames(term, driver.tui);
			const painted = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(painted).toContain("compacting");
			expect(painted).not.toContain("~/a/very/long/path/indeed");
			for (const row of term.getViewport())
				expect(Bun.stringWidth(Bun.stripANSI(row).trimEnd())).toBeLessThanOrEqual(24);
		} finally {
			driver.stop();
		}
	});
});

describe("an update patches its own block", () => {
	test("a streamed tool result replaces the running row without a second block", async () => {
		const { driver, settle, screen } = rig();
		try {
			driver.setTranscriptBlocks([]);
			driver.appendTranscriptBlock({
				kind: "tool-execution",
				id: "tool:c1",
				toolCallId: "c1",
				toolName: "READTOOL",
				status: "running",
				input: "path.ts",
				timestamp: 1,
			});
			await settle();
			expect(screen()).toContain("READTOOL");
			driver.updateTranscriptBlock("tool:c1", { status: "succeeded", output: "FINALOUTPUT" });
			await settle();
			const painted = screen();
			expect(painted).toContain("FINALOUTPUT");
			// One occurrence: a patch that appended would leave the running row above
			// the finished one.
			expect(painted.split("READTOOL").length - 1).toBe(1);
		} finally {
			driver.stop();
		}
	});

	test("patching an unknown id changes nothing and does not throw", async () => {
		const { driver, settle, screen } = rig();
		try {
			driver.setTranscriptBlocks([blockOfKind("user-message")]);
			await settle();
			const before = screen();
			driver.updateTranscriptBlock("no-such-block", { kind: "error" } as Partial<TranscriptBlock>);
			await settle();
			expect(screen()).toBe(before);
		} finally {
			driver.stop();
		}
	});

	test("replacing the transcript unmounts the previous blocks", async () => {
		const { driver, settle, screen } = rig();
		try {
			driver.setTranscriptBlocks([blockOfKind("user-message")]);
			await settle();
			expect(screen()).toContain("USERTEXT");
			driver.setTranscriptBlocks([blockOfKind("developer-message")]);
			await settle();
			const painted = screen();
			expect(painted).toContain("DEVTEXT");
			expect(painted).not.toContain("USERTEXT");
		} finally {
			driver.stop();
		}
	});

	test("removing a block takes its rows off the screen", async () => {
		const { driver, settle, screen } = rig();
		try {
			driver.setTranscriptBlocks([blockOfKind("user-message"), blockOfKind("developer-message")]);
			await settle();
			driver.removeTranscriptBlock("block-user-message");
			await settle();
			const painted = screen();
			expect(painted).not.toContain("USERTEXT");
			expect(painted).toContain("DEVTEXT");
		} finally {
			driver.stop();
		}
	});

	test("clearing the transcript leaves the chrome standing", async () => {
		const { driver, settle, screen } = rig();
		try {
			driver.setTranscriptBlocks([blockOfKind("user-message")]);
			driver.setStatusLine(status());
			await settle();
			driver.clearTranscript();
			await settle();
			const painted = screen();
			expect(painted).not.toContain("USERTEXT");
			expect(painted).toContain("test/model-one");
		} finally {
			driver.stop();
		}
	});

	test("re-appending a live id updates it instead of drawing it twice", async () => {
		const { driver, settle, screen } = rig();
		try {
			const block = blockOfKind("user-message");
			driver.appendTranscriptBlock(block);
			driver.appendTranscriptBlock({ ...block, text: "SECONDTEXT" } as TranscriptBlock);
			await settle();
			const painted = screen();
			expect(painted).toContain("SECONDTEXT");
			expect(painted).not.toContain("USERTEXT");
		} finally {
			driver.stop();
		}
	});
});

describe("a theme change repaints", () => {
	/** The row the status line occupies, found by its text rather than assumed. */
	function statusRowIndex(term: VirtualTerminal): number {
		const index = term.getViewport().findIndex(row => Bun.stripANSI(row).includes("thinking"));
		if (index < 0) throw new Error("the status line is not on screen");
		return index;
	}

	test("a cached row is rebuilt under the new theme", async () => {
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		// The status line was already drawn and its rows are cached per width, so a
		// theme change with no state push is the only thing that can repaint it. The
		// evidence is the underline flag on the activity segment's cells, read back
		// from the terminal rather than from the bytes the engine emitted.
		const driver = new TerminalPresentationDriver(term, { theme: theme() });
		try {
			driver.start();
			driver.setStatusLine(status({ activity: "thinking" }));
			await settleFrames(term, driver.tui);
			const row = statusRowIndex(term);
			expect(term.getViewportRowUnderlineColumns(row)).toEqual([]);

			driver.setTheme(theme({ accentStyle: { underline: true } }));
			await settleFrames(term, driver.tui);
			const after = statusRowIndex(term);
			// Exactly the eight columns of "thinking": the accent role paints the
			// activity segment and nothing else on the row.
			expect(term.getViewportRowUnderlineColumns(after)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
			expect(Bun.stripANSI(term.getViewport()[after]!)).toContain("test/model-one");
		} finally {
			driver.stop();
		}
	});

	test("a theme change repaints a transcript block too", async () => {
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		const driver = new TerminalPresentationDriver(term, { theme: theme() });
		try {
			driver.start();
			// A bash block's command row is painted in the accent role.
			driver.setTranscriptBlocks([blockOfKind("bash-execution")]);
			await settleFrames(term, driver.tui);
			const row = term.getViewport().findIndex(line => Bun.stripANSI(line).includes("BASHCOMMAND"));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(term.getViewportRowUnderlineColumns(row)).toEqual([]);

			driver.setTheme(theme({ accentStyle: { underline: true } }));
			await settleFrames(term, driver.tui);
			const after = term.getViewport().findIndex(line => Bun.stripANSI(line).includes("BASHCOMMAND"));
			expect(term.getViewportRowUnderlineColumns(after).length).toBeGreaterThan(0);
		} finally {
			driver.stop();
		}
	});
});

describe("operator input leaves as a UIEvent", () => {
	function collect(driver: TerminalPresentationDriver): UIEvent[] {
		const events: UIEvent[] = [];
		driver.onInput(event => events.push(event));
		return events;
	}

	test("ctrl+c is an interrupt and ctrl+d is an exit that keeps the session", async () => {
		const { term, driver, settle } = rig();
		try {
			const events = collect(driver);
			await settle();
			term.sendInput("\x03");
			term.sendInput("\x04");
			expect(events).toEqual([{ type: "interrupt" }, { type: "exit", save: true }]);
		} finally {
			driver.stop();
		}
	});

	test("page keys scroll by a fraction of the viewport, in both directions", async () => {
		const { term, driver, settle } = rig(20);
		try {
			const events = collect(driver);
			await settle();
			term.sendInput("\x1b[5~");
			term.sendInput("\x1b[6~");
			const deltas = events.filter(event => event.type === "scroll").map(event => event.delta);
			expect(deltas).toEqual([-16, 16]);
		} finally {
			driver.stop();
		}
	});

	test("an unsubscribed handler stops receiving events", async () => {
		const { term, driver, settle } = rig();
		try {
			const events: UIEvent[] = [];
			const unsubscribe = driver.onInput(event => events.push(event));
			await settle();
			term.sendInput("\x03");
			unsubscribe();
			term.sendInput("\x03");
			expect(events).toEqual([{ type: "interrupt" }]);
		} finally {
			driver.stop();
		}
	});

	test("a printable key is not consumed by the driver", async () => {
		// The driver owns a handful of gestures; everything else has to reach the
		// focused component, or a composer can never be typed into.
		const { term, driver, settle } = rig();
		try {
			const events = collect(driver);
			await settle();
			term.sendInput("a");
			expect(events).toEqual([]);
		} finally {
			driver.stop();
		}
	});
});

describe("dialogs resolve with the operator's answer", () => {
	test("an approval prompt approves on y and refuses on n", async () => {
		const { term, driver, settle } = rig();
		try {
			await settle();
			const approving = driver.showDialog({
				kind: "tool-approval",
				id: "approve:c1",
				toolCallId: "c1",
				toolName: "APPROVETOOL",
				input: "rm -rf nothing",
			});
			await settle();
			expect(term.getViewport().join("\n")).toContain("APPROVETOOL");
			term.sendInput("y");
			expect(await approving).toEqual({ outcome: "approved", remember: false });

			const refusing = driver.showDialog({
				kind: "tool-approval",
				id: "approve:c2",
				toolCallId: "c2",
				toolName: "APPROVETOOL",
				input: "rm -rf nothing",
			});
			await settle();
			term.sendInput("n");
			expect(await refusing).toEqual({ outcome: "rejected" });
		} finally {
			driver.stop();
		}
	});

	test("escape cancels rather than approving", async () => {
		// A dismissed prompt must never be read as consent.
		const { term, driver, settle } = rig();
		try {
			await settle();
			const pending = driver.showDialog({
				kind: "tool-approval",
				id: "approve:c3",
				toolCallId: "c3",
				toolName: "APPROVETOOL",
				input: "anything",
			});
			await settle();
			term.sendInput("\x1b");
			expect(await pending).toEqual({ outcome: "cancelled" });
		} finally {
			driver.stop();
		}
	});

	test("a select dialog reports the row the arrows landed on", async () => {
		const { term, driver, settle } = rig();
		try {
			await settle();
			const pending = driver.showDialog({
				kind: "select",
				id: "pick",
				title: "PICKTITLE",
				options: [
					{ value: "first", label: "FIRSTROW" },
					{ value: "second", label: "SECONDROW" },
					{ value: "third", label: "THIRDROW" },
				],
				selectedIndex: 0,
				multi: false,
				filterable: false,
			});
			await settle();
			expect(term.getViewport().join("\n")).toContain("SECONDROW");
			term.sendInput("\x1b[B");
			term.sendInput("\x1b[B");
			term.sendInput("\x1b[A");
			term.sendInput("\r");
			expect(await pending).toEqual({ outcome: "selected", values: ["second"] });
		} finally {
			driver.stop();
		}
	});

	test("a prompt dialog reports the text that was typed, masked or not", async () => {
		const { term, driver, settle } = rig();
		try {
			await settle();
			const pending = driver.showDialog({
				kind: "prompt",
				id: "ask",
				title: "ASKTITLE",
				placeholder: "type here",
				initialValue: "",
				masked: true,
			});
			await settle();
			term.sendInput("a");
			term.sendInput("b");
			term.sendInput("c");
			await settle();
			const painted = term.getViewport().join("\n");
			// Masked means the characters are not on screen, which is the whole point
			// of the flag; the reported value still carries them.
			expect(Bun.stripANSI(painted)).not.toContain("abc");
			term.sendInput("\x7f");
			term.sendInput("\r");
			expect(await pending).toEqual({ outcome: "entered", value: "ab" });
		} finally {
			driver.stop();
		}
	});

	test("a confirm dialog answers once, and a second keystroke does not answer again", async () => {
		const { term, driver, settle } = rig();
		try {
			await settle();
			const pending = driver.showDialog({
				kind: "confirm",
				id: "sure",
				title: "SURETITLE",
				body: "BODYTEXT",
				confirmLabel: "Do it",
				cancelLabel: "Stop",
				destructive: true,
			});
			await settle();
			expect(term.getViewport().join("\n")).toContain("BODYTEXT");
			term.sendInput("y");
			term.sendInput("n");
			expect(await pending).toEqual({ outcome: "confirmed" });
		} finally {
			driver.stop();
		}
	});
});

describe("overlays", () => {
	test("an overlay paints, updates in place and closes", async () => {
		const { term, driver, settle } = rig();
		try {
			await settle();
			const handle = driver.showOverlay({
				id: "card",
				anchor: "center",
				rows: ["FIRSTROWTEXT"],
				interactive: false,
				dismissable: true,
			});
			await settle();
			expect(term.getViewport().join("\n")).toContain("FIRSTROWTEXT");
			handle.update({
				id: "card",
				anchor: "center",
				rows: ["SECONDROWTEXT"],
				interactive: false,
				dismissable: true,
			});
			await settle();
			const painted = term.getViewport().join("\n");
			expect(painted).toContain("SECONDROWTEXT");
			expect(painted).not.toContain("FIRSTROWTEXT");
			handle.close();
			await settle();
			expect(term.getViewport().join("\n")).not.toContain("SECONDROWTEXT");
		} finally {
			driver.stop();
		}
	});

	test("closing an unknown id, or closing twice, is not an error", async () => {
		const { driver, settle } = rig();
		try {
			await settle();
			const handle = driver.showOverlay({
				id: "once",
				anchor: "top",
				rows: ["x"],
				interactive: false,
				dismissable: true,
			});
			handle.close();
			handle.close();
			driver.closeOverlay("never-existed");
			await settle();
			expect(driver.running).toBe(true);
		} finally {
			driver.stop();
		}
	});
});

describe("lifecycle", () => {
	test("start is idempotent and stop leaves the driver not running", async () => {
		const { driver, settle } = rig();
		try {
			driver.start();
			expect(driver.running).toBe(true);
			await settle();
		} finally {
			driver.stop();
		}
		expect(driver.running).toBe(false);
	});

	test("stopping twice does not throw", () => {
		const { driver } = rig();
		driver.stop();
		driver.stop();
		expect(driver.running).toBe(false);
	});

	test("width and height report the terminal's own dimensions", () => {
		const { term, driver } = rig();
		try {
			expect(driver.width).toBe(term.columns);
			expect(driver.height).toBe(term.rows);
		} finally {
			driver.stop();
		}
	});

	test("scroll position is zero while following the live tail", async () => {
		const { driver, settle } = rig();
		try {
			driver.setTranscriptBlocks([blockOfKind("user-message")]);
			await settle();
			expect(driver.scrollPosition).toBe(0);
			driver.scrollToLive();
			expect(driver.scrollPosition).toBe(0);
		} finally {
			driver.stop();
		}
	});

	test("scrolling back off the live tail reports how far back it is", async () => {
		const { driver, settle } = rig(10);
		try {
			const blocks: TranscriptBlock[] = [];
			for (let i = 0; i < 40; i++) {
				blocks.push({ kind: "developer-message", id: `d${i}`, text: `row ${i}`, timestamp: i });
			}
			driver.setTranscriptBlocks(blocks);
			driver.setComposerState(composer());
			await settle();
			expect(driver.scrollable).toBe(true);
			driver.scrollBy(-5);
			await settle();
			// Termination and bound: the position ends up positive and no larger than
			// the rows asked for, rather than running away or staying pinned.
			expect(driver.scrollPosition).toBeGreaterThan(0);
			expect(driver.scrollPosition).toBeLessThanOrEqual(5);
			driver.scrollToLive();
			await settle();
			expect(driver.scrollPosition).toBe(0);
		} finally {
			driver.stop();
		}
	});
});
