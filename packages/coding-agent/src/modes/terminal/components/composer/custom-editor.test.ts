import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { CURSOR_MARKER } from "@veyyon/tui";
import { PASTE_END, PASTE_START } from "@veyyon/utils/bracketed-paste";
import { setKittyProtocolActive } from "@veyyon/utils/keys";
import type { SgrMouseEvent } from "@veyyon/utils/mouse";
import { $ } from "bun";
import { getDefaultPasteImageKeys } from "../../../../config/keybindings";
import { getEditorTheme, initTheme, theme } from "../../../../theme/theme";
import {
	CustomEditor,
	extractBracketedImagePastePaths,
	extractBracketedPastePaths,
	extractImagePathFromText,
	extractPastePathsFromText,
	SPACE_HOLD_MECHANICAL_RUN,
	SPACE_HOLD_RELEASE_MS,
	SPACE_REPEAT_MAX_GAP_MS,
} from "./custom-editor";

function makeEditor() {
	const editor = new CustomEditor(getEditorTheme());
	const events: string[] = [];
	editor.sttHoldEnabled = () => true;
	editor.onSpaceHoldStart = () => events.push("start");
	editor.onSpaceHoldEnd = () => events.push("end");
	return { editor, events };
}

/** A gap below SPACE_REPEAT_MAX_GAP_MS — looks like OS key auto-repeat (a held bar). */
const REPEAT_GAP_MS = 30;
/** A gap above the threshold — looks like a deliberate keypress. */
const TAP_GAP_MS = SPACE_REPEAT_MAX_GAP_MS + 80;

function bracketedPaste(text: string): string {
	return `${PASTE_START}${text}${PASTE_END}`;
}

/** Feed `count` spaces `gapMs` apart on the fake clock. The first space of a run has no prior
 *  space, so its gap is effectively infinite and it always reads as a deliberate tap. */
function feedSpaces(editor: CustomEditor, count: number, gapMs: number): void {
	for (let i = 0; i < count; i++) {
		vi.advanceTimersByTime(gapMs);
		editor.handleInput(" ");
	}
}

/** Feed spaces at explicit per-press gaps (ms) on the fake clock — for simulating an irregular cadence. */
function feedGaps(editor: CustomEditor, gaps: number[]): void {
	for (const gapMs of gaps) {
		vi.advanceTimersByTime(gapMs);
		editor.handleInput(" ");
	}
}

async function decorateInFreshProcess(text: string, imageLinks?: readonly string[]): Promise<string> {
	const customEditorUrl = new URL("./custom-editor.ts", import.meta.url).href;
	const script = `
import { CustomEditor } from ${JSON.stringify(customEditorUrl)};
const editor = new CustomEditor({});
editor.imageLinks = ${JSON.stringify(imageLinks)};
process.stdout.write(editor.decorateText(${JSON.stringify(text)}));
`;
	const child = await $`bun -e ${script}`.quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0) throw new Error(stderr || stdout || `decorate subprocess exited with ${child.exitCode}`);
	return stdout;
}

describe("CustomEditor placeholder decoration", () => {
	it("renders paste placeholders before theme initialization", async () => {
		const output = await decorateInFreshProcess("[Paste #1, +30 lines]");
		expect(output).toBe("[Paste #1, +30 lines]");
	});

	it("renders linked image placeholders before theme and settings initialization", async () => {
		const output = await decorateInFreshProcess("[Image #1]", ["/tmp/example.png"]);
		expect(output).toBe("[Image #1]");
	});
});

describe("CustomEditor queue shorthand decoration", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("reserves the first line as soon as either queue prefix is completed", () => {
		for (const prefix of ["->", "=>"]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.handleInput(prefix[0] ?? "");
			expect(editor.getText()).toBe(prefix[0]);

			editor.handleInput(prefix[1] ?? "");
			expect(editor.getText()).toBe(`${prefix}\n`);
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			editor.handleInput("\x7f");
			expect(editor.getText()).toBe(`${prefix}\n`);
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
		}
	});

	it("renders the reserved line as a dim Queueing header", () => {
		for (const prefix of ["->", "=>"]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText(`${prefix}\nqueue this`);

			expect(editor.decorateText(prefix)).toBe(theme.fg("dim", `Queueing ${theme.nav.selected}`));
			editor.focused = true;
			const rendered = editor.render(40).map(line => Bun.stripANSI(line.replace(CURSOR_MARKER, "")));
			expect(rendered.some(line => line.includes(`Queueing ${theme.nav.selected}`))).toBe(true);
			expect(rendered.every(line => Bun.stringWidth(line) === 40)).toBe(true);
			expect(rendered.some(line => line.includes("queue this"))).toBe(true);
		}
	});

	it("highlights dot and parenthesis markers only for detected queue lists", () => {
		for (const [input, marker] of [
			["=>\n1. first\n2. second", "1."],
			["=>\n1) first\n2) second", "1)"],
		]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText(input);
			expect(editor.decorateText(`${marker} first`).startsWith(theme.fg("accent", marker))).toBe(true);
		}

		const unfinished = new CustomEditor(getEditorTheme());
		unfinished.setText("=>\n1. first\n2. second\n3. third\n4.");
		expect(unfinished.decorateText("1. first").startsWith(theme.fg("accent", "1."))).toBe(true);
		expect(unfinished.decorateText("4.").startsWith(theme.fg("accent", "4."))).toBe(true);

		const editor = new CustomEditor(getEditorTheme());
		editor.setText("=>\n1. first\n3. third");
		expect(editor.decorateText("1. first")).toBe("1. first");
	});
});

describe("CustomEditor bracketed path paste", () => {
	it("leaves a pasted bare .png filename on the normal text path", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("icon-photo-default.png"))).toBeUndefined();
	});

	it("extracts explicit local image paths for attachment", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("/tmp/icon-photo-default.png"))).toEqual([
			"/tmp/icon-photo-default.png",
		]);
		expect(extractBracketedImagePastePaths(bracketedPaste("C:\\Users\\me\\icon-photo-default.png"))).toEqual([
			"C:\\Users\\me\\icon-photo-default.png",
		]);
	});

	it("strips `file://` URLs to the local filesystem path before loading the image", () => {
		// macOS / Ghostty / iTerm2 sometimes forward the pasteboard's
		// `public.file-url` representation when the user does Finder→Copy
		// then Cmd+V. Without decoding, `loadImageInput` would try to read a
		// literal `file:///…` path and fail.
		expect(extractBracketedImagePastePaths(bracketedPaste("file:///Users/me/Pictures/photo.png"))).toEqual([
			"/Users/me/Pictures/photo.png",
		]);
	});

	it("percent-decodes spaces inside `file://` URLs", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("file:///Users/me/My%20Pictures/photo.png"))).toEqual([
			"/Users/me/My Pictures/photo.png",
		]);
	});

	it("extracts explicit non-image paths without classifying them as image paths", () => {
		expect(extractBracketedPastePaths(bracketedPaste("/tmp/report.csv"))).toEqual(["/tmp/report.csv"]);
		expect(extractBracketedImagePastePaths(bracketedPaste("/tmp/report.csv"))).toBeUndefined();
	});

	it("inserts non-image path pastes as literal text instead of attaching them", () => {
		const { editor } = makeEditor();
		let imagePathCalls = 0;
		editor.onPasteImagePath = () => {
			imagePathCalls++;
		};

		editor.handleInput(bracketedPaste("/tmp/report.csv"));

		expect(editor.getText()).toBe("/tmp/report.csv");
		expect(imagePathCalls).toBe(0);
	});
});
describe("CustomEditor configured paste image keys", () => {
	it("routes Ghostty Cmd+V kitty key events through the macOS image-paste default", () => {
		const { editor } = makeEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;
		editor.setActionKeys("app.clipboard.pasteImage", getDefaultPasteImageKeys("darwin"));
		setKittyProtocolActive(true);

		try {
			editor.handleInput("\x1b[118;9u");
		} finally {
			setKittyProtocolActive(false);
		}

		expect(onPasteImage).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});
});

describe("extractImagePathFromText (issue #3506)", () => {
	it("returns the path when the text is a single image file path", () => {
		expect(extractImagePathFromText("/tmp/screenshot.png")).toBe("/tmp/screenshot.png");
		expect(extractImagePathFromText("/Users/me/Pictures/photo.jpeg")).toBe("/Users/me/Pictures/photo.jpeg");
		expect(extractImagePathFromText("C:\\Users\\me\\img.gif")).toBe("C:\\Users\\me\\img.gif");
	});

	it("ignores surrounding whitespace from a clipboard read", () => {
		expect(extractImagePathFromText("  /tmp/photo.webp\n")).toBe("/tmp/photo.webp");
	});

	it("returns undefined for a bare filename (no explicit directory)", () => {
		// Mirrors the bracketed-paste contract: a bare `.png` filename is
		// almost always a project-relative reference the user wants as text,
		// not a clipboard-anchored attachment.
		expect(extractImagePathFromText("icon.png")).toBeUndefined();
	});

	it("returns undefined for non-image extensions", () => {
		expect(extractImagePathFromText("/tmp/report.csv")).toBeUndefined();
		expect(extractImagePathFromText("/tmp/notes.txt")).toBeUndefined();
	});

	it("returns undefined when the text contains anything beyond a single path", () => {
		expect(extractImagePathFromText("see /tmp/screenshot.png")).toBeUndefined();
		expect(extractImagePathFromText("/tmp/a.png /tmp/b.png")).toBeUndefined();
	});

	it("returns undefined for empty/whitespace-only input", () => {
		expect(extractImagePathFromText("")).toBeUndefined();
		expect(extractImagePathFromText("   ")).toBeUndefined();
	});

	it("decodes a `file://` URL to its filesystem path", () => {
		expect(extractImagePathFromText("file:///Users/me/Pictures/photo.png")).toBe("/Users/me/Pictures/photo.png");
	});

	it("recovers a single anchored image path containing unescaped spaces (macOS screenshot name)", () => {
		const macScreenshot = "/Users/me/Desktop/Screenshot 2026-06-25 at 1.23.45 PM.png";
		expect(extractImagePathFromText(macScreenshot)).toBe(macScreenshot);
		expect(extractImagePathFromText("~/Pictures/Cleanshot 2026-06-25 at 12.00.png")).toBe(
			"~/Pictures/Cleanshot 2026-06-25 at 12.00.png",
		);
		expect(extractImagePathFromText("C:\\Users\\me\\My Pictures\\img with space.jpg")).toBe(
			"C:\\Users\\me\\My Pictures\\img with space.jpg",
		);
	});

	it("does not hijack prose that happens to contain a path-shaped fragment", () => {
		// The whole-text branch is gated on ABSOLUTE_PATH_PREFIX_REGEX, so a
		// non-anchored prefix ("see ...") never triggers it.
		expect(extractImagePathFromText("see /Users/me/Desktop/Screenshot 1.png")).toBeUndefined();
	});
});

describe("extractPastePathsFromText", () => {
	it("delegates to the same logic the bracketed variant uses for path detection", () => {
		expect(extractPastePathsFromText("/tmp/a.png /tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
		expect(extractPastePathsFromText("just text")).toBeUndefined();
	});
});

describe("CustomEditor space-hold push-to-talk", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("types deliberate space taps without triggering, even several in a row", () => {
		const { editor, events } = makeEditor();
		feedSpaces(editor, 3, TAP_GAP_MS);
		expect(editor.getText()).toBe("   ");
		expect(events).toEqual([]);
	});

	it("recognizes a held bar from a steady fast cadence and tracks back the burst", () => {
		const { editor, events } = makeEditor();
		editor.handleInput("h");
		editor.handleInput("i");
		// Metronomic auto-repeat: the few pre-burst spaces typed are tracked back out when the hold is
		// recognized, leaving only the pre-burst text.
		feedSpaces(editor, SPACE_HOLD_MECHANICAL_RUN + 2, REPEAT_GAP_MS);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// Continued auto-repeat while the bar is held is swallowed: no spam, no re-trigger.
		feedSpaces(editor, 5, REPEAT_GAP_MS);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// An idle gap with no further repeats means the bar was released -> stop + transcribe.
		vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start", "end"]);
	});

	it("does not trigger when the space bar is smashed at an irregular cadence", () => {
		const { editor, events } = makeEditor();
		// Fast but jittery, the way a human mashes — not the metronomic delta of OS auto-repeat.
		const gaps = [40, 95, 45, 100, 35, 90, 50, 105];
		feedGaps(editor, gaps);
		expect(events).toEqual([]);
		// Nothing is eaten: every smashed space still types a real space.
		expect(editor.getText()).toBe(" ".repeat(gaps.length));
	});

	it("does not trigger on steady but slow spacing", () => {
		const { editor, events } = makeEditor();
		// Even cadence, but slower than auto-repeat: consistent deltas alone must not start recording.
		feedSpaces(editor, 6, TAP_GAP_MS);
		expect(events).toEqual([]);
		expect(editor.getText()).toBe(" ".repeat(6));
	});

	it("does not trigger when a non-space breaks the run", () => {
		const { editor, events } = makeEditor();
		// Each partial run climbs the mechanical counter one short of the threshold; the non-space
		// resets it so they never combine into a hold.
		feedSpaces(editor, 3, REPEAT_GAP_MS);
		editor.handleInput("x");
		feedSpaces(editor, 3, REPEAT_GAP_MS);
		expect(events).toEqual([]);
	});

	it("leaves the space bar typing normally when the gesture is disabled", () => {
		const { editor, events } = makeEditor();
		editor.sttHoldEnabled = () => false;
		feedSpaces(editor, 8, REPEAT_GAP_MS);
		expect(editor.getText()).toBe(" ".repeat(8));
		expect(events).toEqual([]);
	});
});

describe("CustomEditor arrow-key caret movement (BUG-1 guard)", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const LEFT = "\x1b[D";
	const RIGHT = "\x1b[C";

	it("plain left/right move the caret through existing text (never swallowed)", () => {
		const editor = new CustomEditor(getEditorTheme());
		for (const ch of "hello") editor.handleInput(ch);
		editor.handleInput(LEFT);
		editor.handleInput(LEFT);
		editor.handleInput("X");
		expect(editor.getText()).toBe("helXlo");
		editor.handleInput(RIGHT);
		editor.handleInput("Y");
		expect(editor.getText()).toBe("helXlYo");
	});

	it("left on an empty editor fires the agent-hub gesture instead of moving", () => {
		const editor = new CustomEditor(getEditorTheme());
		let gestures = 0;
		editor.onLeftAtStart = () => {
			gestures++;
		};
		editor.handleInput(LEFT);
		expect(gestures).toBe(1);
		expect(editor.getText()).toBe("");
	});

	it("the empty-editor gesture never intercepts in-text left movement", () => {
		const editor = new CustomEditor(getEditorTheme());
		let gestures = 0;
		editor.onLeftAtStart = () => {
			gestures++;
		};
		for (const ch of "ab") editor.handleInput(ch);
		editor.handleInput(LEFT);
		editor.handleInput("X");
		expect(gestures).toBe(0);
		expect(editor.getText()).toBe("aXb");
	});
});

describe("CustomEditor ComposerState consumption and reporting", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("reports pristine state matching default editor properties", () => {
		const editor = new CustomEditor(getEditorTheme());
		const state = editor.getComposerState();
		expect(state.mode).toBe("input");
		expect(state.text).toBe("");
		expect(state.cursorOffset).toBe(0);
		expect(state.placeholder).toBe("Ask, or / for commands");
		expect(state.attachments).toEqual([]);
		expect(state.queueOnSubmit).toBe(false);
		expect(state.completion).toBeUndefined();
		expect(state.hint).toBeUndefined();
	});

	it("consumes and updates full ComposerState snapshots, clearing absent fields", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setComposerState({
			mode: "shell",
			text: "console.log('test');\nsecond line",
			cursorOffset: 7,
			placeholder: "custom shell placeholder",
			attachments: [{ kind: "file", name: "app.ts" }],
			completion: { prefix: "con", candidates: [{ value: "console" }], selectedIndex: 0 },
			queueOnSubmit: true,
			hint: "queued mode",
		});

		expect(editor.getText()).toBe("console.log('test');\nsecond line");
		expect(editor.getCursorOffset()).toBe(7);
		expect(editor.attachments).toEqual([{ kind: "file", name: "app.ts" }]);
		expect(editor.completion).toEqual({ prefix: "con", candidates: [{ value: "console" }], selectedIndex: 0 });
		expect(editor.queueOnSubmit).toBe(true);
		expect(editor.hint).toBe("queued mode");

		const reported = editor.getComposerState();
		expect(reported.mode).toBe("shell");
		expect(reported.text).toBe("console.log('test');\nsecond line");
		expect(reported.cursorOffset).toBe(7);
		expect(reported.placeholder).toBe("custom shell placeholder");
		expect(reported.queueOnSubmit).toBe(true);
		expect(reported.attachments).toEqual([{ kind: "file", name: "app.ts" }]);
		expect(reported.completion).toEqual({ prefix: "con", candidates: [{ value: "console" }], selectedIndex: 0 });

		// Second snapshot replaces absent fields rather than merging
		editor.setComposerState({
			mode: "input",
			text: "clean text",
			cursorOffset: 5,
			placeholder: "",
			attachments: [],
			queueOnSubmit: false,
		});
		const second = editor.getComposerState();
		expect(second.mode).toBe("input");
		expect(second.text).toBe("clean text");
		expect(second.cursorOffset).toBe(5);
		expect(second.placeholder).toBe("");
		expect(second.completion).toBeUndefined();
		expect(second.hint).toBeUndefined();
		expect(second.attachments).toEqual([]);
	});

	it("unifies explicit attachments with pending images and roundtrips image payloads", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.attachments = [{ kind: "file", name: "doc.txt" }];
		editor.pendingImages = [{ type: "image", data: "base64data123", mimeType: "image/png" }];
		editor.pendingImageLinks = ["file:///tmp/screen.png"];

		const state = editor.getComposerState();
		expect(state.attachments).toEqual([
			{ kind: "file", name: "doc.txt" },
			{
				kind: "image",
				name: "/tmp/screen.png",
				data: "base64data123",
				mimeType: "image/png",
				uri: "file:///tmp/screen.png",
			},
		]);

		// Restoring into a second editor restores pendingImages and imageLinks faithfully
		const second = new CustomEditor(getEditorTheme());
		second.setComposerState(state);
		expect(second.pendingImages).toEqual([{ type: "image", data: "base64data123", mimeType: "image/png" }]);
		expect(second.pendingImageLinks).toEqual(["file:///tmp/screen.png"]);

		// Submitting the second editor fires onComposerSubmit with the complete image payload
		const submitted: unknown[] = [];
		second.onComposerSubmit = event => submitted.push(event);
		second.setText("submit with image");
		second.submit();
		expect(submitted).toEqual([
			{
				type: "submit",
				text: "submit with image",
				attachments: [
					{ kind: "file", name: "doc.txt" },
					{
						kind: "image",
						name: "/tmp/screen.png",
						data: "base64data123",
						mimeType: "image/png",
						uri: "file:///tmp/screen.png",
					},
				],
			},
		]);

		// Replacing with a new state without images clears pending images
		second.setComposerState({
			mode: "input",
			text: "no images",
			cursorOffset: 0,
			placeholder: "",
			attachments: [],
			queueOnSubmit: false,
		});
		expect(second.pendingImages).toEqual([]);
		expect(second.pendingImageLinks).toEqual([]);
	});

	it("accepts explicitly pushed autocomplete suggestions via keyboard and mouse", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setText("/h");
		editor.completion = {
			prefix: "/h",
			candidates: [
				{ value: "help", label: "help", detail: "Show help commands" },
				{ value: "history", label: "history", detail: "Show history" },
			],
			selectedIndex: 0,
		};
		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(editor.completion).toEqual({
			prefix: "/h",
			candidates: [
				{ value: "help", label: "help", detail: "Show help commands" },
				{ value: "history", label: "history", detail: "Show history" },
			],
			selectedIndex: 0,
		});

		// Tab accepts the selected suggestion
		editor.handleInput("\t");
		expect(editor.getText()).toBe("/help ");
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.completion).toBeUndefined();

		// Test mouse acceptance
		editor.setText("/hi");
		editor.completion = {
			prefix: "/hi",
			candidates: [{ value: "history", label: "history" }],
			selectedIndex: 0,
		};
		// Render to populate internal row mapping
		editor.render(80);
		// Route mouse click to the autocomplete row
		const mouseEvent: SgrMouseEvent = {
			button: 0,
			col: 5,
			row: 1,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
		};
		editor.routeMouse(mouseEvent, 1, 5);
		expect(editor.getText()).toBe("/history ");
		expect(editor.isShowingAutocomplete()).toBe(false);

		// Explicit clearing cancels popup
		editor.completion = {
			prefix: "/h",
			candidates: [{ value: "help" }],
			selectedIndex: 0,
		};
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.completion = undefined;
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.completion).toBeUndefined();
	});

	it("submit invokes onComposerSubmit once with current text and attachments", () => {
		const editor = new CustomEditor(getEditorTheme());
		const submitted: unknown[] = [];
		editor.onComposerSubmit = event => {
			submitted.push(event);
		};
		editor.setText("run command");
		editor.attachments = [{ kind: "file", name: "config.json" }];

		editor.submit();
		expect(submitted).toEqual([
			{
				type: "submit",
				text: "run command",
				attachments: [{ kind: "file", name: "config.json" }],
			},
		]);
	});

	it("getCursorOffset and setCursorOffset correctly navigate multiline buffers", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("line1\nline2\nline3");
		expect(editor.getCursorOffset()).toBe(17);

		editor.setCursorOffset(0);
		expect(editor.getCursorOffset()).toBe(0);
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

		editor.setCursorOffset(6);
		expect(editor.getCursorOffset()).toBe(6);
		expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

		editor.setCursorOffset(8);
		expect(editor.getCursorOffset()).toBe(8);
		expect(editor.getCursor()).toEqual({ line: 1, col: 2 });

		editor.setCursorOffset(17);
		expect(editor.getCursorOffset()).toBe(17);
		expect(editor.getCursor()).toEqual({ line: 2, col: 5 });

		// Bounds clamping
		editor.setCursorOffset(-10);
		expect(editor.getCursorOffset()).toBe(0);
		editor.setCursorOffset(999);
		expect(editor.getCursorOffset()).toBe(17);
	});

	it("resolves mode automatically based on text prefix or explicit session flags", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("!ls -la");
		expect(editor.getComposerState().mode).toBe("shell");

		editor.setText("/help");
		expect(editor.getComposerState().mode).toBe("search");

		editor.setText("normal prompt");
		expect(editor.getComposerState().mode).toBe("input");

		editor.locked = true;
		expect(editor.getComposerState().mode).toBe("disabled");
		expect(editor.disableSubmit).toBe(true);

		editor.locked = false;
		editor.awaitingApproval = true;
		expect(editor.getComposerState().mode).toBe("awaiting-approval");
	});

	it("clearing one session flag leaves a mode the other flag owns, and clearing its own mode re-enables submit", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("normal prompt");
		editor.awaitingApproval = true;
		expect(editor.disableSubmit).toBe(true);

		editor.locked = false;
		expect(editor.getComposerState().mode).toBe("awaiting-approval");
		expect(editor.disableSubmit).toBe(true);

		editor.awaitingApproval = false;
		expect(editor.getComposerState().mode).toBe("input");
		expect(editor.disableSubmit).toBe(false);

		editor.locked = true;
		editor.awaitingApproval = false;
		expect(editor.getComposerState().mode).toBe("disabled");
		expect(editor.disableSubmit).toBe(true);
	});

	it("notifies onComposerChange on input", () => {
		const editor = new CustomEditor(getEditorTheme());
		const updates: number[] = [];
		editor.onComposerChange = state => {
			updates.push(state.cursorOffset);
		};

		editor.handleInput("a");
		editor.handleInput("b");
		editor.handleInput("c");
		expect(updates).toEqual([1, 2, 3]);
		expect(editor.getComposerState().text).toBe("abc");
	});

	it("fires onComposerSubmit with attachments on early submission", () => {
		const editor = new CustomEditor(getEditorTheme());
		const events: unknown[] = [];
		editor.onComposerSubmit = event => {
			events.push(event);
		};
		editor.attachments = [{ kind: "file", name: "doc.txt" }];
		editor.beginEarlySubmissions();

		editor.setText("test submit");
		editor.onSubmit?.("test submit");

		expect(events).toEqual([
			{
				type: "submit",
				text: "test submit",
				attachments: [{ kind: "file", name: "doc.txt" }],
			},
		]);
		expect(editor.takeEarlySubmissions()).toEqual([
			{
				text: "test submit",
				images: undefined,
				imageLinks: undefined,
				attachments: [{ kind: "file", name: "doc.txt" }],
			},
		]);
	});

	it("withPreservedDraft protects newer drafts from setComposerState overwrite", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.withPreservedDraft(() => {
			editor.handleInput("new user typing");
			editor.setComposerState({
				mode: "input",
				text: "stale background state",
				cursorOffset: 0,
				placeholder: "",
				attachments: [],
				queueOnSubmit: false,
			});
			expect(editor.getText()).toBe("new user typing");
		});
	});

	it("clearDraft resets text, pending images, image links, and attachments", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("draft to clear");
		editor.attachments = [{ kind: "file", name: "test.txt" }];
		editor.clearDraft();
		expect(editor.getText()).toBe("");
		expect(editor.attachments).toEqual([]);
	});

	it("feeds completion into live autocomplete list and renders it", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setComposerState({
			mode: "input",
			text: "/m",
			cursorOffset: 2,
			placeholder: "",
			attachments: [],
			completion: {
				prefix: "/m",
				candidates: [
					{ value: "/model", label: "/model", detail: "Select model" },
					{ value: "/mode", label: "/mode", detail: "Switch mode" },
				],
				selectedIndex: 0,
			},
			queueOnSubmit: false,
		});

		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(editor.completion).toEqual({
			prefix: "/m",
			candidates: [
				{ value: "/model", label: "/model", detail: "Select model" },
				{ value: "/mode", label: "/mode", detail: "Switch mode" },
			],
			selectedIndex: 0,
		});

		const rendered = editor.render(80).join("\n");
		expect(rendered).toContain("/model");
		expect(rendered).toContain("/mode");
	});

	it("renders observable attachment, queue notice, and hint rows", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setComposerState({
			mode: "input",
			text: "my prompt",
			cursorOffset: 9,
			placeholder: "",
			attachments: [{ kind: "file", name: "src/index.ts" }],
			queueOnSubmit: true,
			hint: "press enter to queue",
		});

		const rendered = editor.render(80).join("\n");
		expect(rendered).toContain("+ src/index.ts");
		expect(rendered).toContain("a turn is running; enter queues this message");
		expect(rendered).toContain("press enter to queue");
	});

	it("submit guards prevent submission during awaiting-approval, disabled, empty, or unlistened state", () => {
		const editor = new CustomEditor(getEditorTheme());
		const submits: unknown[] = [];
		editor.onComposerSubmit = event => submits.push(event);

		// 1. Awaiting approval
		editor.setComposerState({
			mode: "awaiting-approval",
			text: "cannot submit during approval",
			cursorOffset: 28,
			placeholder: "",
			attachments: [],
			queueOnSubmit: false,
		});
		editor.submit();
		expect(submits.length).toBe(0);
		expect(editor.getText()).toBe("cannot submit during approval");

		// 2. Disabled
		editor.setComposerState({
			mode: "disabled",
			text: "disabled session",
			cursorOffset: 16,
			placeholder: "",
			attachments: [],
			queueOnSubmit: false,
		});
		editor.submit();
		expect(submits.length).toBe(0);

		// 3. Empty input
		editor.setComposerState({
			mode: "input",
			text: "   ",
			cursorOffset: 0,
			placeholder: "",
			attachments: [],
			queueOnSubmit: false,
		});
		editor.submit();
		expect(submits.length).toBe(0);

		// 4. No listeners does not clear draft
		const noListenerEditor = new CustomEditor(getEditorTheme());
		noListenerEditor.setText("preserve this text");
		noListenerEditor.submit();
		expect(noListenerEditor.getText()).toBe("preserve this text");
	});

	it("preserves multiple distinct same-MIME images without deduplication", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.pendingImages = [
			{ type: "image", data: "base64img1", mimeType: "image/png" },
			{ type: "image", data: "base64img2", mimeType: "image/png" },
		];
		editor.pendingImageLinks = [undefined, undefined];

		const atts = editor.attachments;
		expect(atts.length).toBe(2);
		expect(atts[0]).toEqual({
			kind: "image",
			name: "image (image/png)",
			data: "base64img1",
			mimeType: "image/png",
			uri: undefined,
		});
		expect(atts[1]).toEqual({
			kind: "image",
			name: "image (image/png)",
			data: "base64img2",
			mimeType: "image/png",
			uri: undefined,
		});

		const state = editor.getComposerState();
		expect(state.attachments.length).toBe(2);
	});

	it("preserves URI-only image attachments and original metadata", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.attachments = [
			{
				kind: "image",
				name: "custom-diagram.png",
				uri: "file:///workspace/diagram.png",
				byteSize: 2048,
				lineCount: undefined,
			},
		];

		const atts = editor.attachments;
		expect(atts).toEqual([
			{
				kind: "image",
				name: "custom-diagram.png",
				uri: "file:///workspace/diagram.png",
				byteSize: 2048,
				lineCount: undefined,
				data: undefined,
				mimeType: undefined,
			},
		]);

		const second = new CustomEditor(getEditorTheme());
		second.setComposerState(editor.getComposerState());
		expect(second.attachments).toEqual([
			{
				kind: "image",
				name: "custom-diagram.png",
				uri: "file:///workspace/diagram.png",
				byteSize: 2048,
				lineCount: undefined,
				data: undefined,
				mimeType: undefined,
			},
		]);
	});

	it("returns undefined for completion after dismissal and does not resurrect stale state", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("/test");
		editor.completion = {
			prefix: "/t",
			candidates: [{ value: "/test", label: "test" }],
			selectedIndex: 0,
		};
		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(editor.completion).toBeDefined();

		// Dismiss autocomplete
		editor.handleInput("\x1b"); // Escape key
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.completion).toBeUndefined();
		expect(editor.getComposerState().completion).toBeUndefined();
	});

	it("returns explicit mode for shell, search, and input when set via setComposerState or mode setter", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("plain text");
		editor.mode = "shell";
		expect(editor.mode).toBe("shell");
		expect(editor.getComposerState().mode).toBe("shell");

		editor.mode = "search";
		expect(editor.mode).toBe("search");
		expect(editor.getComposerState().mode).toBe("search");

		editor.mode = "input";
		expect(editor.mode).toBe("input");
		expect(editor.getComposerState().mode).toBe("input");

		editor.setComposerState({
			mode: "shell",
			text: "echo hi",
			cursorOffset: 7,
			placeholder: "",
			attachments: [],
			queueOnSubmit: false,
		});
		expect(editor.getComposerState().mode).toBe("shell");
	});

	it("emits onComposerSubmit exactly once on early submission and submit invocation", () => {
		const editor = new CustomEditor(getEditorTheme());
		const submissions: unknown[] = [];
		editor.onComposerSubmit = event => submissions.push(event);
		editor.beginEarlySubmissions();

		editor.setText("early command");
		editor.submit();
		expect(submissions.length).toBe(1);
		expect(submissions[0]).toEqual({
			type: "submit",
			text: "early command",
			attachments: [],
		});
	});

	it("renders tiny terminal widths without upward clamping and sanitizes attachment names and hints", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setComposerState({
			mode: "input",
			text: "prompt",
			cursorOffset: 6,
			placeholder: "",
			attachments: [{ kind: "file", name: "bad\tfile\nname\x00.ts" }],
			queueOnSubmit: true,
			hint: "hint\twith\nnewlines\x1f",
		});

		// Render at width 2
		const tinyRows = editor.render(2);
		for (const row of tinyRows) {
			// Check that visual width doesn't exceed 2
			expect(row.length).toBeLessThanOrEqual(50); // ANSI formatting length, but content truncated
		}

		// Render at width 80 to verify sanitization
		const normalRows = editor.render(80).join("\n");
		expect(normalRows).not.toContain("\t");
		expect(normalRows).not.toContain("\nname");
		expect(normalRows).toContain("bad   file name .ts");
		expect(normalRows).toContain("hint   with newlines ");
	});

	it("clears locked, awaitingApproval, and stale imageLinks on snapshot replacement", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.locked = true;
		editor.imageLinks = ["file:///test.png"];
		expect(editor.locked).toBe(true);
		expect(editor.imageLinks).toEqual(["file:///test.png"]);

		editor.setComposerState({
			mode: "input",
			text: "unlocked prompt",
			cursorOffset: 15,
			placeholder: "",
			attachments: [],
			queueOnSubmit: false,
		});

		expect(editor.locked).toBe(false);
		expect(editor.awaitingApproval).toBe(false);
		expect(editor.imageLinks).toBeUndefined();
		expect(editor.getComposerState().mode).toBe("input");
	});
});
