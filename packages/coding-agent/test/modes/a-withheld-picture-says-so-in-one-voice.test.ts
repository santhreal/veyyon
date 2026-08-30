/**
 * WHY:
 * A picture the terminal will not draw leaves a row of text behind, and that row
 * was the last surface in the product still speaking the bracketed dialect the
 * rest of the withheld-content class left behind: `[image not shown, images off
 * (Show Inline Images)] board.png · image/png · 1920x1080`. Four paths drew it —
 * the tool block's own rows, the `Image` component's fallback, the assistant
 * message's placeholder and the protocol probe's swatch — in three weights, so
 * one screen held the same fact in `dim` on one block and `toolOutput` on the
 * next, and the media type was repeated beside a file name that already stated
 * it, which is what crowded the cause off a narrow terminal.
 *
 * The class this suite closes: every reason a picture is withheld, stated in the
 * voice every other withheld-content row uses (the leading ellipsis, the facts,
 * the affordance last in parentheses) and in that class's one weight, on every
 * path that draws it. The remedy is swept against the settings schema, so a row
 * that names a switch names one that exists.
 *
 * What it does not catch: whether a terminal that claims a protocol actually drew
 * the picture, which only the terminal can answer; the pixel box the picture is
 * resampled to; and the sentence the MODEL is told, which is a different audience
 * with a different owner (`imageDisplayStateForCall`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import os from "node:os";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { getUi, hasUi, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { foldRow } from "@veyyon/coding-agent/modes/components/fold-row";
import { readArgsGroupable } from "@veyyon/coding-agent/modes/components/read-tool-group";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { theme } from "@veyyon/coding-agent/modes/theme/theme-binding";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/render-utils";
import {
	type AnsiPolicy,
	getAnsiPolicy,
	IMAGE_FALLBACK_CAUSE,
	type ImageFallbackReason,
	ImageProtocol,
	imageFallback,
	setAnsiPolicy,
	setTerminalImageProtocol,
	TERMINAL,
	type TUI,
} from "@veyyon/tui";
import { IMAGE_MIME_BY_EXTENSION } from "@veyyon/utils/mime";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { createToolExecution } from "../helpers/tool-execution";

/** 1x1 PNG, the smallest payload whose dimensions can be measured. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** The row's opening and its parenthesised cause, whatever facts sit between them. */
const WITHHELD_ROW = /^… image not shown · (?<facts>.+?) \((?<cause>[^)]+)\)$/u;

/** `turn on Show Inline Images in /settings` — the remedy shape, and the label it names. */
const REMEDY = /(?:turn on|raise) (?<label>.+) in \/settings/u;

/** The reasons whose cause names a settings row rather than a fact about the terminal. */
const REASONS_WITH_A_REMEDY: readonly ImageFallbackReason[] = ["images-off", "over-budget"];

/** Every label the settings screen draws, which is what a remedy is allowed to name. */
function settingsLabels(): Set<string> {
	const labels = new Set<string>();
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		if (!hasUi(path)) continue;
		const label = getUi(path)?.label;
		if (label) labels.add(label);
	}
	return labels;
}

/**
 * The weight the row itself is painted in: the last colour set before its text
 * starts.
 *
 * Two ways an assertion on this stops meaning anything. With the ANSI policy on
 * `plain` — which is what a piped test run detects — every painter returns its
 * text unchanged, so every comparison holds against any weight at all; the arm
 * "can see a weight at all" fails the suite rather than letting that pass. And a
 * rendered line opens with the block's rail, which the titanium palette paints in
 * the same colour this class uses, so a comparison against the whole prefix is
 * satisfied by the rail even after the row is repainted. Only the last sequence
 * before the text belongs to the row.
 */
function weightOf(painted: string): string {
	const beforeText = painted.slice(0, painted.indexOf("…"));
	return beforeText.match(/\u001b\[[0-9;]*m/gu)?.at(-1) ?? "";
}

let originalProtocol: ImageProtocol | null = null;
let originalPolicy: AnsiPolicy = "plain";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, "unicode", false, "titanium", "dark");
	originalProtocol = TERMINAL.imageProtocol;
	// The weight of a row is an escape sequence, so the policy that decides whether
	// one is emitted is part of this suite's subject and is pinned rather than
	// inherited from whatever stream the run happens to have.
	originalPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterEach(() => {
	setTerminalImageProtocol(originalProtocol);
});

afterAll(() => {
	setTerminalImageProtocol(originalProtocol);
	setAnsiPolicy(originalPolicy);
	resetSettingsForTest();
});

describe("the row a withheld picture leaves", () => {
	/**
	 * The variant space is the cause table itself, so a fifth reason is red here
	 * until it is written in the voice rather than green because nobody listed it.
	 */
	it("states every reason in the withheld-content voice", () => {
		const reasons = Object.keys(IMAGE_FALLBACK_CAUSE) as ImageFallbackReason[];
		expect(reasons.length).toBeGreaterThanOrEqual(4);

		for (const reason of reasons) {
			const row = imageFallback({ mimeType: "image/png", dimensions: { widthPx: 8, heightPx: 8 }, reason });
			const parsed = WITHHELD_ROW.exec(row);

			expect(parsed?.groups, row).toBeDefined();
			expect(parsed?.groups?.facts, row).toBe("image/png · 8x8");
			expect(parsed?.groups?.cause, row).toBe(IMAGE_FALLBACK_CAUSE[reason]);
		}
	});

	/**
	 * A cause the operator can undo names the row that undoes it, the way every
	 * other remedy in the product names one. The opted-out set is pinned by exact
	 * equality: a new reason that is a setting and stays silent about it is red.
	 */
	it("names a settings row that exists, wherever the cause is a setting", () => {
		const labels = settingsLabels();
		const naming: ImageFallbackReason[] = [];

		for (const [reason, cause] of Object.entries(IMAGE_FALLBACK_CAUSE) as [ImageFallbackReason, string][]) {
			const remedy = REMEDY.exec(cause);
			if (!remedy?.groups) continue;
			naming.push(reason);
			expect(labels.has(remedy.groups.label), `${reason} names "${remedy.groups.label}"`).toBe(true);
		}

		expect(naming.sort()).toEqual([...REASONS_WITH_A_REMEDY].sort());
	});

	/** The media type beside a file name that already states it is one fact twice. */
	it("states the media type only when the file name does not", () => {
		const row = (filename: string | undefined, mimeType: string): string =>
			imageFallback({ filename, mimeType, reason: "no-protocol" });

		expect(row("board.png", "image/png")).toContain("· board.png (");
		expect(row("photo.JPG", "image/jpeg")).toContain("· photo.JPG (");
		expect(row("diagram.svg", "image/svg+xml")).toContain("· diagram.svg (");
		// The extension disagrees with the payload, or there is none: the type is
		// the only thing that says what the file holds.
		expect(row("capture.bin", "image/png")).toContain("· capture.bin · image/png (");
		expect(row("screenshot", "image/png")).toContain("· screenshot · image/png (");
		expect(row(undefined, "image/webp")).toContain("· image/webp (");
	});
});

describe("every path that draws the row draws it in one weight", () => {
	/** The weight the withheld-content class takes, read off the fold row's owner. */
	const foldWeight = (): string => weightOf(foldRow(3));

	it("paints a tool block's placeholder in the fold row's weight", async () => {
		setTerminalImageProtocol(null);
		const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
		const component = createToolExecution(
			"a_tool_with_no_renderer",
			{ path: "shots/board.png" },
			{ showImages: true },
			undefined,
			ui,
			process.cwd(),
			"call_weight",
		);
		component.setArgsComplete();
		component.updateResult(
			{
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: TINY_PNG, mimeType: "image/png" },
				],
				details: { resolvedPath: `${process.cwd()}/shots/board.png` },
			},
			false,
		);
		await component.whenPreviewSettled();

		const painted = component.render(140).find(line => line.includes("image not shown"));
		expect(painted, "no withheld-picture row in the block").toBeDefined();
		expect(weightOf(painted ?? "")).toContain(foldWeight());
	});

	/**
	 * A tool block reaches the row down two different paths: the picture is handed
	 * to the `Image` component and its fallback speaks (the arm above), or the
	 * block decided against drawing it before any paint and writes the rows
	 * itself. Both are on screen in the same transcript, so both are asserted.
	 * This arm gives the terminal a protocol, so the setting is what withholds the
	 * picture and the row carries the remedy an operator can act on.
	 */
	it("paints a placeholder the block decided on itself in the same weight", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
		const component = createToolExecution(
			"a_tool_with_no_renderer",
			{ path: "shots/board.png" },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
			"call_images_off",
		);
		component.setArgsComplete();
		component.updateResult(
			{
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: TINY_PNG, mimeType: "image/png" },
				],
				details: { resolvedPath: `${process.cwd()}/shots/board.png` },
			},
			false,
		);
		await component.whenPreviewSettled();

		const painted = component.render(140).find(line => line.includes("image not shown"));
		expect(painted, "no withheld-picture row for a block that drew none").toBeDefined();
		expect(painted).toContain("images off, turn on Show Inline Images in /settings");
		expect(weightOf(painted ?? "")).toContain(foldWeight());
	});

	/**
	 * The row names a file, so it obeys the display contract every other row that
	 * shows a path obeys: the home directory collapsed, and the path inside the
	 * budget, or a deep tree pushes the cause off the end of the row it is the
	 * point of.
	 */
	it("keeps the file it names inside the row's path budget", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const deep = `${os.homedir()}/${"a-directory-with-a-long-name/".repeat(8)}board.png`;
		const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
		const component = createToolExecution(
			"a_tool_with_no_renderer",
			{ path: deep },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
			"call_deep_path",
		);
		component.setArgsComplete();
		component.updateResult(
			{
				content: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }],
				details: { resolvedPath: deep },
			},
			false,
		);
		await component.whenPreviewSettled();

		const painted = component.render(200).find(line => line.includes("image not shown"));
		const facts = WITHHELD_ROW.exec(
			stripAnsi(painted ?? "")
				.trim()
				.replace(/^▏ /u, ""),
		);

		expect(facts?.groups?.facts, painted).toBeDefined();
		const named = (facts?.groups?.facts ?? "").split(" · ")[0] ?? "";
		expect(named.startsWith("~/"), named).toBe(true);
		expect(named.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.CONTENT);
		expect(painted).toContain("images off, turn on Show Inline Images in /settings");
	});

	/**
	 * A tool that owns its result layout draws its own frame, its own header and
	 * its own sections, and `read` is the tool an operator reaches a picture
	 * through. The row is the block's, not the renderer's, so it is on screen for
	 * a custom renderer too — otherwise the surface a user actually meets is the
	 * one path in the class with no row at all.
	 */
	it("shows the row even when the tool draws its own result", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
		const component = createToolExecution(
			"read",
			{ path: "shots/board.png" },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
			"call_read_image",
		);
		component.setArgsComplete();
		component.updateResult(
			{
				content: [
					{ type: "text", text: "Read image file [image/png]\n[Image: original 1600x1000]" },
					{ type: "image", data: TINY_PNG, mimeType: "image/png" },
				],
				details: { resolvedPath: `${process.cwd()}/shots/board.png` },
			},
			false,
		);
		await component.whenPreviewSettled();

		const painted = component.render(140).find(line => line.includes("image not shown"));
		expect(painted, "the read block drew no withheld-picture row").toBeDefined();
		expect(painted).toContain("images off, turn on Show Inline Images in /settings");
		expect(weightOf(painted ?? "")).toContain(foldWeight());
	});

	it("paints an assistant message's placeholder in the same weight", () => {
		setTerminalImageProtocol(null);
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const component = new AssistantMessageComponent(message, false, undefined, []);
		component.setToolResultImages("read-1", [{ type: "image", data: TINY_PNG, mimeType: "image/png" }]);

		const painted = component.render(140).find(line => line.includes("image not shown"));
		expect(painted, "no withheld-picture row in the message").toBeDefined();
		expect(weightOf(painted ?? "")).toContain(foldWeight());
	});

	/** The weight is the class's, not a colour this suite happens to know. */
	it("uses the weight the fold row uses, not one of its own", () => {
		expect(foldWeight()).toBe(weightOf(theme.fg("dim", "… anything")));
	});

	/**
	 * Every arm above compares one painter's prefix against the class's. With no
	 * colour on the wire every prefix is empty and every one of those comparisons
	 * holds against any weight at all, which is how a repaint of the tool block's
	 * rows once passed this describe block untouched. This arm is the one that
	 * cannot: it names the two weights that were confused and requires them to be
	 * distinguishable here.
	 */
	it("can see a weight at all, so the comparisons above mean something", () => {
		expect(foldWeight()).toMatch(/\u001b\[/u);
		expect(weightOf(theme.fg("toolOutput", "… anything"))).not.toBe(foldWeight());
	});
});

describe("a read of a picture reaches a block that can show one", () => {
	/**
	 * The variant space is the extension table itself, so a sixth image type is
	 * red here until routing knows about it. A read of a picture that lands in the
	 * read group shows a file row and nothing else: no picture with images on, and
	 * no row saying why with them off.
	 */
	it("keeps every image the mime table names out of the read group", () => {
		const extensions = [...IMAGE_MIME_BY_EXTENSION.keys()];
		expect(extensions.length).toBeGreaterThanOrEqual(5);

		for (const extension of extensions) {
			expect(readArgsGroupable({ path: `shots/board${extension}` }), extension).toBe(false);
			expect(readArgsGroupable({ file_path: `shots/board${extension.toUpperCase()}` }), extension).toBe(false);
			expect(readArgsGroupable({ path: `shots/board${extension}:1-20` }), extension).toBe(false);
		}
	});

	/** The group is still where an ordinary file read goes; this is not a bypass. */
	it("keeps an ordinary file read in the group", () => {
		expect(readArgsGroupable({ path: "src/index.ts" })).toBe(true);
		expect(readArgsGroupable({ path: "notes.md:10-20" })).toBe(true);
		expect(readArgsGroupable({ path: "screenshot.pngx" })).toBe(true);
		expect(readArgsGroupable({})).toBe(false);
	});
});
