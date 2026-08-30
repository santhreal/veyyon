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
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { getUi, hasUi, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { foldRow } from "@veyyon/coding-agent/modes/components/fold-row";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { theme } from "@veyyon/coding-agent/modes/theme/theme-binding";
import {
	IMAGE_FALLBACK_CAUSE,
	type ImageFallbackReason,
	type ImageProtocol,
	imageFallback,
	setTerminalImageProtocol,
	TERMINAL,
	type TUI,
} from "@veyyon/tui";
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

/** The SGR prefix a painter puts in front of its text, which is the row's weight. */
function weightOf(painted: string): string {
	return painted.slice(0, painted.indexOf("…"));
}

let originalProtocol: ImageProtocol | null = null;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, "unicode", false, "titanium", "dark");
	originalProtocol = TERMINAL.imageProtocol;
});

afterEach(() => {
	setTerminalImageProtocol(originalProtocol);
});

afterAll(() => {
	setTerminalImageProtocol(originalProtocol);
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
});
