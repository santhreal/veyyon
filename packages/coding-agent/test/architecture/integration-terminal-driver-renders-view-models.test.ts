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
 * Driving the driver drives the transcript and chrome components behind it:
 * `driver.ts` mounts `TranscriptBlockComponent` for the transcript and
 * `StatusLineComponent` and `CustomEditor` for the status line and composer.
 * Their contract is what a VT displays, and it is asserted here rather than
 * against isolated return values.
 *
 * What it does NOT catch: colour fidelity on a 256-colour terminal (the encoding
 * is chosen by `@veyyon/utils/color-format` and asserted in its own suite), and
 * mouse routing, which the engine owns.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, TUI } from "@veyyon/tui";
import type { ComposerState, StatusLineState, SubmitEvent, TranscriptBlock, UIEvent } from "@veyyon/wire/presentation";
import { TRANSCRIPT_BLOCK_KINDS } from "@veyyon/wire/presentation";
import { settleFrames } from "../../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../hosts/terminal/engine/test/virtual-terminal";
import { Settings } from "../../src/config/settings";
import { QuietZoneLine } from "../../src/modes/terminal/components/composer/composer-chrome";
import { CustomEditor } from "../../src/modes/terminal/components/composer/custom-editor";
import { StatusLineComponent } from "../../src/modes/terminal/components/status-line/component";
import { ChatTranscriptBuilder } from "../../src/modes/terminal/components/transcript/chat-transcript-builder";
import { TranscriptContainer } from "../../src/modes/terminal/components/transcript/transcript-container";
import { type TerminalDriverSurface, TerminalPresentationDriver } from "../../src/modes/terminal/driver";
import { applyPresentationTheme, getEditorTheme } from "../../src/theme/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeStatusLineProducer } from "../helpers/status-line-session";
import { testTheme as theme } from "./helpers/presentation-theme";

const WIDTH = 80;
const HEIGHT = 24;

let settingsState: SettingsTestState | undefined;
let originalAnsiPolicy: AnsiPolicy | undefined;
beforeEach(async () => {
	originalAnsiPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	settingsState = beginSettingsTest();
	await Settings.init({
		inMemory: true,
		overrides: {
			"statusLine.preset": "custom",
			"statusLine.leftSegments": ["model"],
			"statusLine.rightSegments": ["session_name"],
			"statusLine.sessionAccent": false,
		},
	});
	applyPresentationTheme(theme());
});
afterEach(() => {
	if (originalAnsiPolicy !== undefined) setAnsiPolicy(originalAnsiPolicy);
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function status(overrides: Partial<StatusLineState> = {}): StatusLineState {
	return {
		...makeStatusLineProducer({
			modelId: "test/model-one",
			modelName: "test/model-one",
			sessionName: "STATUSSESSION",
			cwd: () => "/repo",
			contextWindow: 10_000,
			contextUsage: { tokens: 2_000, contextWindow: 10_000 },
		}).getSnapshot(),
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
			return { kind, id, summary: "BRANCHSUMMARY", timestamp };
		case "compaction-summary":
			return { kind, id, summary: "COMPACTIONSUMMARY", tokensBefore: 4096, timestamp };
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
	"branch-summary": "branch",
	"compaction-summary": "compacted",
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
			driver.setStatusLine(status());
			driver.setComposerState(composer({ text: "COMPOSERTEXT" }));
			await settle();
			const painted = screen();
			expect(painted).toContain("USERTEXT");
			expect(painted).toContain("test/model-one");
			expect(painted).toContain("STATUSSESSION");
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

	test("a narrow frame sheds secondary status content and keeps the model", async () => {
		// The narrow frame is where a segment is dropped, so it is asserted here
		// rather than inferred from the wide one.
		const term = new VirtualTerminal(24, HEIGHT, 5_000);
		const driver = new TerminalPresentationDriver(term, { theme: theme() });
		try {
			driver.start();
			const snapshot = status();
			snapshot.facts.sessionName = "SECONDARYSESSIONTOOLONGFORTHISFRAME";
			driver.setStatusLine(snapshot);
			await settleFrames(term, driver.tui);
			const painted = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(painted).toContain("test/model-one");
			expect(painted).not.toContain("SECONDARYSESSIONTOOLONGFORTHISFRAME");
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

	test("standalone read blocks retain their individual result cards", async () => {
		const { driver, settle, screen } = rig();
		try {
			for (const [id, output] of [
				["first", "FIRSTREADOUTPUT"],
				["second", "SECONDREADOUTPUT"],
			] as const) {
				driver.appendTranscriptBlock({
					kind: "tool-execution",
					id,
					toolCallId: id,
					toolName: "read",
					status: "succeeded",
					input: JSON.stringify({ path: `src/${id}.ts` }),
					output,
					timestamp: 1_700_000_000_000,
					display: {
						readEntry: { toolCallId: id, path: `src/${id}.ts`, status: "success" },
						generic: { icon: "done", outputText: output },
					},
				});
			}
			await settle();
			expect(screen()).toContain("FIRSTREADOUTPUT");
			expect(screen()).toContain("SECONDREADOUTPUT");
		} finally {
			driver.stop();
		}
	});
});

describe("a theme change repaints", () => {
	/** The row the status line occupies, found by its text rather than assumed. */
	function statusRowIndex(term: VirtualTerminal): number {
		const index = term.getViewport().findIndex(row => Bun.stripANSI(row).includes("test/model-one"));
		if (index < 0) throw new Error("the status line is not on screen");
		return index;
	}

	test("a cached row is rebuilt under the new theme", async () => {
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		// The status line was already drawn and its rows are cached per width, so a
		// theme change with no state push is the only thing that can repaint it. The
		// evidence is the underline flag on the model segment's cells, read back
		// from the terminal rather than from the bytes the engine emitted.
		const driver = new TerminalPresentationDriver(term, { theme: theme() });
		try {
			driver.start();
			driver.setStatusLine(status());
			await settleFrames(term, driver.tui);
			const row = statusRowIndex(term);
			expect(term.getViewportRowUnderlineColumns(row)).toEqual([]);

			driver.setTheme(theme({ styles: { statusLineModel: { underline: true } } }));
			await settleFrames(term, driver.tui);
			const after = statusRowIndex(term);
			const text = Bun.stripANSI(term.getViewport()[after]!);
			const start = text.indexOf("test/model-one");
			const underlined = term.getViewportRowUnderlineColumns(after);
			for (let column = start; column < start + "test/model-one".length; column++) {
				expect(underlined).toContain(column);
			}
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
			expect(events).toEqual([{ type: "composer-change", text: "a", cursorOffset: 1 }]);
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
	test.each([false, true])("routes input only to interactive overlays: %s", async interactive => {
		const { term, driver, settle, screen } = rig();
		const events: UIEvent[] = [];
		driver.onInput(event => events.push(event));
		const composerFocus = driver.tui.getFocused();
		try {
			const view = {
				id: "input-card",
				anchor: "center" as const,
				title: "OVERLAYTITLE",
				rows: ["OVERLAYBODY"],
				interactive,
				dismissable: false,
			};
			const handle = driver.showOverlay(view);
			await settle();
			expect(screen()).toContain("OVERLAYTITLE");
			expect(screen()).toContain("OVERLAYBODY");
			term.sendInput("a");
			term.sendInput("\x1b");
			await settle();
			expect(screen()).toContain("OVERLAYBODY");
			expect(events.filter(event => event.type === "composer-change")).toEqual(
				interactive ? [] : [{ type: "composer-change", text: "a", cursorOffset: 1 }],
			);
			handle.update({ ...view, interactive: !interactive, dismissable: true });
			if (interactive) expect(driver.tui.getFocused()).toBe(composerFocus);
			else expect(driver.tui.getFocused()).not.toBe(composerFocus);
			await settle();
			term.sendInput("b");
			const changes = events.filter(event => event.type === "composer-change");
			expect(changes.at(-1)).toEqual({
				type: "composer-change",
				text: interactive ? "b" : "a",
				cursorOffset: 1,
			});
			if (!interactive) {
				term.sendInput("\x1b");
				await settle();
				expect(screen()).not.toContain("OVERLAYBODY");
			}
			handle.close();
			term.sendInput("c");
			expect(events.filter(event => event.type === "composer-change").at(-1)).toEqual({
				type: "composer-change",
				text: interactive ? "bc" : "ac",
				cursorOffset: 2,
			});
		} finally {
			driver.stop();
		}
	});

	test("replacement handles cannot close or update the replacement", async () => {
		const { driver, settle, screen } = rig();
		try {
			const view = {
				id: "replace-card",
				anchor: "center" as const,
				rows: ["OLDOVERLAY"],
				interactive: false,
				dismissable: false,
			};
			const old = driver.showOverlay(view);
			const current = driver.showOverlay({ ...view, rows: ["NEWOVERLAY"] });
			old.close();
			old.update({ ...view, rows: ["STALEUPDATE"] });
			await settle();
			expect(screen()).toContain("NEWOVERLAY");
			expect(screen()).not.toContain("OLDOVERLAY");
			expect(screen()).not.toContain("STALEUPDATE");
			expect(() => current.update({ ...view, id: "renamed" })).toThrow("Cannot change overlay id");
			await settle();
			expect(screen()).toContain("NEWOVERLAY");
			driver.closeOverlay("replace-card");
			await settle();
			expect(screen()).not.toContain("NEWOVERLAY");
			expect(screen()).not.toContain("OLDOVERLAY");
			expect(screen()).not.toContain("STALEUPDATE");
		} finally {
			driver.stop();
		}
	});

	test("page keys scroll the overlay rather than the transcript", async () => {
		const { term, driver, settle, screen } = rig(8);
		const events: UIEvent[] = [];
		driver.onInput(event => events.push(event));
		try {
			driver.showOverlay({
				id: "scroll-card",
				anchor: "center",
				title: "SCROLLTITLE",
				rows: Array.from({ length: 30 }, (_, index) => `CONTENTROW${index.toString().padStart(2, "0")}`),
				interactive: true,
				dismissable: true,
			});
			await settle();
			expect(screen()).toContain("CONTENTROW00");
			term.sendInput("\x1b[6~");
			await settle();
			expect(screen()).not.toContain("CONTENTROW00");
			expect(screen()).toContain("SCROLLTITLE");
			expect(events.filter(event => event.type === "scroll")).toEqual([]);
			term.sendInput("\x1b[5~");
			await settle();
			expect(screen()).toContain("CONTENTROW00");
		} finally {
			driver.stop();
		}
	});

	test("anchor updates reposition the same overlay", async () => {
		const { driver, settle, rows } = rig();
		try {
			driver.setComposerState(composer({ text: "BASE" }));
			const view = {
				id: "position-card",
				anchor: "top" as const,
				rows: ["POSITIONTEXT"],
				interactive: false,
				dismissable: false,
			};
			const handle = driver.showOverlay(view);
			await settle();
			const top = rows().findIndex(line => line.includes("POSITIONTEXT"));
			handle.update({ ...view, anchor: "bottom" });
			await settle();
			const bottom = rows().findIndex(line => line.includes("POSITIONTEXT"));
			handle.update({ ...view, anchor: "center" });
			await settle();
			const center = rows().findIndex(line => line.includes("POSITIONTEXT"));
			expect(top).toBeGreaterThanOrEqual(0);
			expect(center).toBeGreaterThan(top);
			expect(bottom).toBeGreaterThan(center);
			handle.update({ ...view, anchor: "fullscreen" });
			await settle();
			expect(rows().filter(line => line.includes("POSITIONTEXT"))).toHaveLength(1);
			expect(rows().join("\n")).not.toContain("BASE");
			expect(
				Bun.stringWidth(
					rows()
						.find(line => line.includes("POSITIONTEXT"))!
						.trim(),
				),
			).toBe(WIDTH);
			handle.update(view);
			await settle();
			expect(rows().findIndex(line => line.includes("POSITIONTEXT"))).toBe(top);
			expect(rows().join("\n")).toContain("BASE");
			expect(
				Bun.stringWidth(
					rows()
						.find(line => line.includes("POSITIONTEXT"))!
						.trim(),
				),
			).toBe(Math.floor(WIDTH * 0.8));
		} finally {
			driver.stop();
		}
	});

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
	test.each(["created", "running", "stopped"] as const)("stop releases pending card clocks from %s", state => {
		vi.useFakeTimers();
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		const driver = new TerminalPresentationDriver(term, { theme: theme() });
		const initialTimers = vi.getTimerCount();
		try {
			if (state !== "created") driver.start();
			if (state === "stopped") driver.stop();
			driver.appendTranscriptBlock({
				kind: "tool-execution",
				id: "pending",
				toolCallId: "pending",
				toolName: "TOOLNAME",
				status: "running",
				input: "{}",
				timestamp: 1_700_000_000_000,
			});
			vi.advanceTimersByTime(240);
			driver.stop();
			vi.advanceTimersByTime(2_000);
			expect(vi.getTimerCount()).toBe(initialTimers);
		} finally {
			driver.stop();
			vi.useRealTimers();
		}
	});

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

describe("surface adoption", () => {
	interface AdoptedRig {
		term: VirtualTerminal;
		tui: TUI;
		container: TranscriptContainer;
		builder: ChatTranscriptBuilder;
		statusComponent: StatusLineComponent;
		statusRow: QuietZoneLine;
		composer: CustomEditor;
		driver: TerminalPresentationDriver;
		settle: () => Promise<void>;
		screen: () => string;
		rows: () => string[];
	}

	function adoptedRig(height = HEIGHT, width = WIDTH): AdoptedRig {
		const term = new VirtualTerminal(width, height, 5_000);
		const tui = new TUI(term, false);
		tui.setScrollbackRebuild(false);
		tui.setScrollIsolation(true);

		const container = new TranscriptContainer();
		const builder = new ChatTranscriptBuilder({
			container,
			ui: tui,
			requestRender: () => tui.requestRender(),
			cwd: "/repo",
		});

		const initialSnapshot = status();
		const statusComponent = new StatusLineComponent({
			getSnapshot: () => initialSnapshot,
			getRevision: () => 0,
		});

		const composer = new CustomEditor(getEditorTheme());
		const statusRow = new QuietZoneLine(width => statusComponent.renderQuietLine(width));

		tui.addChild(container);
		tui.addChild(statusRow);
		tui.addChild(composer);
		tui.setFocus(composer);
		tui.setPinnedFooterChildCount(2);

		const surface: TerminalDriverSurface = {
			getTui: () => tui,
			getComposer: () => composer,
			transcript: builder,
			setStatusLine: state => {
				statusComponent.setSnapshot(state);
			},
		};

		tui.start();
		const driver = new TerminalPresentationDriver(term, { theme: theme(), surface });
		driver.start();

		const settle = () => settleFrames(term, tui);
		const rows = () => term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const screen = () => rows().join("\n");

		return {
			term,
			tui,
			container,
			builder,
			statusComponent,
			statusRow,
			composer,
			driver,
			settle,
			screen,
			rows,
		};
	}

	test("adopts the existing engine and component tree without allocating duplicate root components", () => {
		const rig = adoptedRig();
		try {
			expect(rig.driver.tui).toBe(rig.tui);
			// The three host components (transcript container, status component, composer)
			// are the only children on the root engine.
			expect(rig.tui.children).toEqual([rig.container, rig.statusRow, rig.composer]);
		} finally {
			rig.driver.stop();
			rig.tui.stop();
		}
	});

	test("adopted transcript and status operations update host components and repaint VirtualTerminal", async () => {
		const rig = adoptedRig();
		try {
			// Set initial transcript block, status line, and composer state
			rig.driver.setTranscriptBlocks([blockOfKind("user-message")]);
			const initialStatus = status();
			initialStatus.facts.sessionName = "ADOPTEDSESSION";
			rig.driver.setStatusLine(initialStatus);
			rig.driver.setComposerState(composer({ text: "ADOPTEDCOMPOSER" }));
			await rig.settle();

			expect(rig.screen()).toContain("USERTEXT");
			expect(rig.screen()).toContain("ADOPTEDSESSION");
			expect(rig.screen()).toContain("ADOPTEDCOMPOSER");

			// Append another block
			rig.driver.appendTranscriptBlock(blockOfKind("developer-message"));
			await rig.settle();
			expect(rig.screen()).toContain("DEVTEXT");

			// Update block in place
			rig.driver.updateTranscriptBlock("block-user-message", { text: "PATCHED_GREETING" });
			await rig.settle();
			expect(rig.screen()).toContain("PATCHED_GREETING");
			expect(rig.screen()).not.toContain("USERTEXT");

			// Remove block
			rig.driver.removeTranscriptBlock("block-user-message");
			await rig.settle();
			expect(rig.screen()).not.toContain("PATCHED_GREETING");
			expect(rig.screen()).toContain("DEVTEXT");

			// Clear transcript
			rig.driver.clearTranscript();
			await rig.settle();
			expect(rig.screen()).not.toContain("DEVTEXT");
			expect(rig.screen()).toContain("ADOPTEDSESSION");
		} finally {
			rig.driver.stop();
			rig.tui.stop();
		}
	});

	test("composer draft text is seeded on binding so existing draft is not dropped", () => {
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		const tui = new TUI(term, false);
		const composerEditor = new CustomEditor(getEditorTheme());
		composerEditor.setText("existing draft text");
		composerEditor.setCursorOffset(19);

		const hostChanges: string[] = [];
		composerEditor.onComposerChange = state => hostChanges.push(state.text);

		const surface: TerminalDriverSurface = {
			getTui: () => tui,
			getComposer: () => composerEditor,
			transcript: new ChatTranscriptBuilder({
				ui: tui,
				container: new TranscriptContainer(),
				cwd: "/repo",
				requestRender: () => tui.requestRender(),
			}),
			setStatusLine: () => {},
		};

		const driver = new TerminalPresentationDriver(term, { theme: theme(), surface });
		const driverEvents: UIEvent[] = [];
		driver.onInput(event => driverEvents.push(event));
		composerEditor.onComposerChange?.(composerEditor.getComposerState());
		expect(driverEvents).toEqual([]);

		// Modifying the text after adoption emits composer-change accurately
		composerEditor.setText("existing draft text modified");
		composerEditor.setCursorOffset(28);
		composerEditor.onComposerChange?.(composerEditor.getComposerState());

		expect(hostChanges).toContain("existing draft text modified");
		expect(driverEvents).toContainEqual({
			type: "composer-change",
			text: "existing draft text modified",
			cursorOffset: 28,
		});

		driver.stop();
		tui.stop();
	});

	test("composer callbacks are chained without overwriting host handlers, and restored on stop", () => {
		const rig = adoptedRig();
		try {
			const hostChanges: string[] = [];
			const hostSubmits: SubmitEvent[] = [];
			rig.composer.onComposerChange = state => hostChanges.push(state.text);
			rig.composer.onComposerSubmit = event => hostSubmits.push(event);

			// Re-sync after host attached its callbacks
			rig.driver.syncComposer();

			const driverEvents: UIEvent[] = [];
			rig.driver.onInput(event => driverEvents.push(event));

			// Change triggers host callback AND emits driver event
			rig.composer.setText("typed content");
			rig.composer.setCursorOffset(13);
			rig.composer.onComposerChange?.(rig.composer.getComposerState());
			expect(hostChanges).toContain("typed content");
			expect(driverEvents).toContainEqual({
				type: "composer-change",
				text: "typed content",
				cursorOffset: 13,
			});

			// Submit triggers host callback AND emits driver event
			const submitEvt: SubmitEvent = { type: "submit", text: "typed content", attachments: [] };
			rig.composer.onComposerSubmit?.(submitEvt);
			expect(hostSubmits).toEqual([submitEvt]);
			expect(driverEvents).toContainEqual(submitEvt);
			const delivered = [...driverEvents];

			// Lifecycle stop restores composer callbacks without discarding host handlers
			rig.driver.stop();
			rig.composer.setText("post-stop change");
			rig.composer.onComposerChange?.(rig.composer.getComposerState());
			expect(hostChanges).toContain("post-stop change");
			expect(driverEvents).toEqual(delivered);
		} finally {
			rig.driver.stop();
			rig.tui.stop();
		}
	});

	test("adopted input routing does not consume controller gestures, but cancels driver-owned dialogs", async () => {
		const rig = adoptedRig();
		try {
			const driverEvents: UIEvent[] = [];
			rig.driver.onInput(event => driverEvents.push(event));
			await rig.settle();
			const hostInput: string[] = [];
			rig.tui.addInputListener(data => {
				hostInput.push(data);
				return undefined;
			});

			// Standalone driver gestures (Ctrl+C interrupt, Ctrl+D exit, PageUp/PageDown)
			// must NOT be emitted or consumed by the adopted driver; the production EventController owns them.
			rig.term.sendInput("\x03");
			rig.term.sendInput("\x04");
			rig.term.sendInput("\x1b[5~");
			rig.term.sendInput("\x1b[6~");
			expect(driverEvents.filter(e => e.type === "interrupt" || e.type === "exit" || e.type === "scroll")).toEqual(
				[],
			);
			expect(hostInput).toEqual(["\x03", "\x04", "\x1b[5~", "\x1b[6~"]);

			// Driver-owned dialog cancellation via Ctrl+C still works
			const pending = rig.driver.showDialog({
				kind: "confirm",
				id: "modal-cancel-test",
				title: "MODALTITLE",
				body: "MODALBODY",
				confirmLabel: "Yes",
				cancelLabel: "No",
				destructive: false,
			});
			await rig.settle();
			expect(rig.screen()).toContain("MODALTITLE");
			rig.term.sendInput("\x03");
			expect(await pending).toEqual({ outcome: "cancelled" });
			expect(hostInput).toEqual(["\x03", "\x04", "\x1b[5~", "\x1b[6~"]);
		} finally {
			rig.driver.stop();
			rig.tui.stop();
		}
	});

	test.each([false, true])("overlays render on the adopted engine with interactive=%s", async interactive => {
		const rig = adoptedRig();
		try {
			const handle = rig.driver.showOverlay({
				id: "adopt-card",
				anchor: "center",
				rows: ["ADOPTEDOVERLAYCONTENT"],
				interactive,
				dismissable: true,
			});
			expect(rig.tui.hasOverlay()).toBe(interactive);
			await rig.settle();
			expect(rig.screen()).toContain("ADOPTEDOVERLAYCONTENT");

			handle.close();
			expect(rig.tui.hasOverlay()).toBe(false);
		} finally {
			rig.driver.stop();
			rig.tui.stop();
		}
	});

	test("dynamic getters adapt when host swaps composer", () => {
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		const tui = new TUI(term, false);
		const composerA = new CustomEditor(getEditorTheme());
		const composerB = new CustomEditor(getEditorTheme());
		let currentComposer = composerA;

		const surface: TerminalDriverSurface = {
			getTui: () => tui,
			getComposer: () => currentComposer,
			transcript: new ChatTranscriptBuilder({
				ui: tui,
				container: new TranscriptContainer(),
				cwd: "/repo",
				requestRender: () => tui.requestRender(),
			}),
			setStatusLine: () => {},
		};

		const driver = new TerminalPresentationDriver(term, { theme: theme(), surface });
		try {
			driver.setComposerState(composer({ text: "FIRST_EDITOR" }));
			expect(composerA.getText()).toBe("FIRST_EDITOR");

			currentComposer = composerB;
			driver.setComposerState(composer({ text: "SECOND_EDITOR" }));
			expect(composerB.getText()).toBe("SECOND_EDITOR");
		} finally {
			driver.stop();
			tui.stop();
		}
	});

	test("dynamic getters adapt when host replaces TUI with another-size terminal", async () => {
		const termA = new VirtualTerminal(80, 24, 5_000);
		const termB = new VirtualTerminal(120, 40, 5_000);
		const tuiA = new TUI(termA, false);
		const tuiB = new TUI(termB, false);
		tuiA.start();
		tuiB.start();
		let currentTui = tuiA;
		const composer = new CustomEditor(getEditorTheme());

		const surface: TerminalDriverSurface = {
			getTui: () => currentTui,
			getComposer: () => composer,
			transcript: new ChatTranscriptBuilder({
				get ui() {
					return currentTui;
				},
				container: new TranscriptContainer(),
				cwd: "/repo",
				requestRender: () => currentTui.requestRender(),
			}),
			setStatusLine: () => {},
		};

		const driver = new TerminalPresentationDriver(termA, { theme: theme(), surface });
		try {
			expect(driver.width).toBe(80);
			expect(driver.height).toBe(24);

			// Host replaces engine with a larger terminal
			currentTui = tuiB;
			expect(driver.tui).toBe(tuiB);
			expect(driver.width).toBe(120);
			expect(driver.height).toBe(40);

			// An overlay created on the adopted driver uses the replaced engine dimensions
			const handle = driver.showOverlay({
				id: "size-overlay",
				anchor: "center",
				rows: ["SIZETESTCONTENT"],
				interactive: true,
				dismissable: true,
			});

			expect(tuiB.hasOverlay()).toBe(true);
			expect(tuiA.hasOverlay()).toBe(false);
			await settleFrames(termB, tuiB);
			const viewport = termB.getViewport().join("\n");
			expect(viewport).toContain("SIZETESTCONTENT");

			handle.close();
			expect(tuiB.hasOverlay()).toBe(false);
			const events: UIEvent[] = [];
			driver.onInput(event => events.push(event));
			driver.start();
			termB.sendInput("x");
			expect(events).toContainEqual({ type: "resize", width: 120, height: 40 });
		} finally {
			driver.stop();
			tuiA.stop();
			tuiB.stop();
		}
	});

	test("syncComposer rebinds composer callbacks and start does not issue redundant tui.start in adopted mode", () => {
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		const existingTui = new TUI(term, false);
		const composerA = new CustomEditor(getEditorTheme());
		const composerB = new CustomEditor(getEditorTheme());
		let currentComposer = composerA;

		const hostChangesB: string[] = [];
		composerB.onComposerChange = state => hostChangesB.push(state.text);

		const surface: TerminalDriverSurface = {
			getTui: () => existingTui,
			getComposer: () => currentComposer,
			transcript: new ChatTranscriptBuilder({
				ui: existingTui,
				container: new TranscriptContainer(),
				cwd: "/repo",
				requestRender: () => existingTui.requestRender(),
			}),
			setStatusLine: () => {},
		};

		// Host starts engine first
		existingTui.start({ clearScrollback: true });

		const driver = new TerminalPresentationDriver(term, { theme: theme(), surface });
		const driverEvents: UIEvent[] = [];
		driver.onInput(event => driverEvents.push(event));

		// Attaching starts driver without clearing scrollback or double starting
		driver.start();
		expect(driver.running).toBe(true);

		// Swap to composerB and explicitly syncComposer
		currentComposer = composerB;
		const synced = driver.syncComposer();
		expect(synced).toBe(composerB);

		composerB.setText("updated text B");
		composerB.setCursorOffset(14);
		composerB.onComposerChange?.(composerB.getComposerState());

		expect(hostChangesB).toContain("updated text B");
		expect(driverEvents).toContainEqual({
			type: "composer-change",
			text: "updated text B",
			cursorOffset: 14,
		});

		driver.stop();
		existingTui.stop();
	});
});
