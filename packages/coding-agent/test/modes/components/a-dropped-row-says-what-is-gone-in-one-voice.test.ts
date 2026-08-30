/**
 * WHY:
 * Two different facts were wearing the same clothes. A fold row is an offer —
 * the content is held, a key reveals it — and it is quiet, `dim`, and names the
 * chord. A dropped row is a loss: the content is gone and no key brings it back.
 * Five surfaces stated that loss in the fold row's own voice: the extension
 * widget cap wrote `... (widget truncated)` in `muted` with three literal dots,
 * the extension inspector wrote `(truncated at line 20)` and `(truncated at line
 * 15)` in `dim`, a provider error block's clamp wrote `… 3 more lines` in
 * `muted`, and a rebuilt branch wrote `3 tool calls elided —` in dim italic. Only
 * the streaming drop was loud, and it spelled its own plural, so one line lost
 * read `1 earlier lines dropped while streaming`. A reader looking at a dim row
 * that could never expand had no way to tell it from the dim row above it that
 * could.
 *
 * The class this suite closes: every row that says content is gone states it in
 * one shape (`… <count> <noun> dropped (<cause>)`), with the count spelled by the
 * shared counter, in the one weight a loss takes, and never naming an expand key.
 * The two rows are asserted side by side in the execution footer, which draws
 * both at once, because the split between them is the whole point.
 *
 * What it does not catch: whether a surface that drops content draws a row at
 * all — a silent drop has nothing for this suite to find, and only the surface's
 * own test can require one. It also leaves the meta CHIPS alone (`truncated` in a
 * search result's meta line, `[truncated]` on a subagent status line): those are
 * badges in a chip row, not rows in a transcript, and they carry no count.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionUIContext } from "@veyyon/coding-agent/extensibility/extensions";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { CustomEditor } from "@veyyon/coding-agent/modes/components/custom-editor";
import { buildStatusFooter } from "@veyyon/coding-agent/modes/components/execution-shared";
import { InspectorPanel } from "@veyyon/coding-agent/modes/components/extensions/inspector-panel";
import type { ExtensionRow } from "@veyyon/coding-agent/modes/components/extensions/types";
import { droppedRow, droppedText, foldRow } from "@veyyon/coding-agent/modes/components/fold-row";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/controllers/extension-ui-controller";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { theme } from "@veyyon/coding-agent/modes/theme/theme-binding";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { UiHelpers } from "@veyyon/coding-agent/modes/utils/ui-helpers";
import { type AnsiPolicy, Container, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";

/** The shape every row in this class takes, whatever surface drew it. */
const DROPPED_ROW = /^… (?<count>\d+) (?<noun>[a-z ]+?) dropped(?: \((?<cause>[^)]+)\))?$/u;

/**
 * The weight the row itself is painted in: the last colour set before its text.
 *
 * Read off the row and not off the whole line, because a line may open with a
 * rail or an indent painted in some other colour, and a comparison against the
 * whole prefix is satisfied by that instead. `a weight is visible at all` below
 * fails the suite when no colour is emitted, since every comparison here would
 * then hold against any weight.
 */
function weightOf(painted: string): string {
	const beforeText = painted.slice(0, painted.indexOf("…"));
	return beforeText.match(/\u001b\[[0-9;]*m/gu)?.at(-1) ?? "";
}

/** The class's one weight, read off the owner rather than off a colour this file knows. */
function lossWeight(): string {
	return weightOf(droppedRow(3));
}

let originalPolicy: AnsiPolicy = "plain";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, "unicode", false, "titanium", "dark");
	// The weight of a row is an escape sequence, so the policy that decides whether
	// one is emitted is part of this suite's subject and is pinned rather than
	// inherited from whatever stream the run happens to have.
	originalPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	setAnsiPolicy(originalPolicy);
	resetSettingsForTest();
});

describe("the row a dropped surface leaves", () => {
	it("counts through the shared counter at one, so one line lost is not plural", () => {
		expect(droppedText(1)).toBe("… 1 line dropped");
		expect(droppedText(2)).toBe("… 2 lines dropped");
		expect(droppedText(1, { noun: "earlier line" })).toBe("… 1 earlier line dropped");
		expect(droppedText(12, { noun: "tool call" })).toBe("… 12 tool calls dropped");
	});

	it("states a cause last, in parentheses, and omits the parentheses without one", () => {
		expect(droppedText(3, { cause: "preview limit" })).toBe("… 3 lines dropped (preview limit)");
		expect(droppedText(3)).toBe("… 3 lines dropped");
	});

	it("never names a key, because no key brings the content back", () => {
		const rows = [
			droppedText(3),
			droppedText(3, { cause: "streaming" }),
			droppedText(1, { noun: "tool call", cause: "no result on this branch" }),
		];
		for (const row of rows) expect(row).not.toMatch(/expand|ctrl\+|press /iu);
	});

	it("takes a weight the fold row does not, since one is an offer and the other a loss", () => {
		expect(lossWeight()).toBe(weightOf(theme.fg("warning", "… anything")));
		expect(lossWeight()).not.toBe(weightOf(foldRow(3)));
	});

	/**
	 * Every comparison above and below reads an escape sequence out of a painted
	 * row. With no colour on the wire each of them is the empty string compared
	 * against the empty string, and the suite passes having proved nothing.
	 */
	it("can see a weight at all, so the comparisons here mean something", () => {
		expect(lossWeight()).toMatch(/\u001b\[/u);
		expect(weightOf(foldRow(3))).toMatch(/\u001b\[/u);
	});
});

describe("every surface that drops content draws the class's row", () => {
	/** Rows collected from the real surfaces, checked against the shape as a set at the end. */
	const collected: Array<{ surface: string; row: string }> = [];

	function record(surface: string, row: string | undefined): string {
		expect(row, `${surface} drew no dropped row`).toBeDefined();
		collected.push({ surface, row: row ?? "" });
		return row ?? "";
	}

	/**
	 * The execution footer is the one surface that draws both rows at once, so it
	 * is where the split is provable: the same block, in one frame, holding lines
	 * it can reveal and lines it cannot.
	 */
	it("keeps a streamed drop distinct from a fold in the same execution footer", () => {
		const footer = buildStatusFooter({
			status: "complete",
			exitCode: 0,
			truncation: undefined,
			hiddenLineCount: 40,
			droppedLineCount: 1,
		});
		expect(footer).toBeDefined();
		const lines = footer?.render(120) ?? [];
		const dropped = record(
			"execution footer",
			lines.find(line => line.includes("dropped")),
		);
		const fold = lines.find(line => line.includes("more line"));

		expect(dropped).toContain("… 1 earlier line dropped (streaming)");
		expect(fold, "the footer lost its fold row").toBeDefined();
		expect(weightOf(dropped)).toBe(lossWeight());
		expect(weightOf(fold ?? "")).not.toBe(lossWeight());
	});

	it("reports the lines a provider error block clamped away", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			model: "test",
			api: "anthropic-messages",
			provider: "anthropic",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: Array.from({ length: 30 }, (_, i) => `error line ${i + 1}`).join("\n"),
			timestamp: Date.now(),
		};
		const component = new AssistantMessageComponent(message, false, undefined, []);

		const row = record(
			"provider error block",
			component.render(120).find(line => line.includes("dropped")),
		);
		expect(weightOf(row)).toBe(lossWeight());
	});

	it("reports the widget rows an extension was charged for and did not get", async () => {
		const container = new Container();
		let uiContext: ExtensionUIContext | undefined;
		const ctx = {
			editor: new CustomEditor(getEditorTheme()),
			ui: { requestRender: () => {} },
			session: { extensionRunner: undefined },
			hookWidgetContainerAbove: container,
			hookWidgetContainerBelow: new Container(),
			setToolUIContext(context: ExtensionUIContext): void {
				uiContext = context;
			},
			addAutocompleteProvider: () => {},
		} as unknown as InteractiveModeContext;
		await new ExtensionUiController(ctx).initHooksAndCustomTools();
		expect(uiContext).toBeDefined();

		uiContext?.setWidget(
			"build",
			Array.from({ length: 13 }, (_, i) => `widget row ${i + 1}`),
		);

		const row = record(
			"extension widget",
			container.render(120).find(line => line.includes("dropped")),
		);
		expect(row).toContain("… 3 lines dropped (widget line limit)");
		// The three literal dots this row used to open with are not the class's mark.
		expect(row).not.toContain("...");
		expect(weightOf(row)).toBe(lossWeight());
	});

	it("reports the lines an inspector preview stops short of", () => {
		const panel = new InspectorPanel();
		panel.setExtension(contextFileRow(35));

		const row = record(
			"inspector context file",
			[...panel.render(80)].find(line => line.includes("dropped")),
		);
		expect(row).toContain("… 15 lines dropped (preview limit)");
		expect(weightOf(row)).toBe(lossWeight());
	});

	it("reports the lines a skill instruction preview stops short of", () => {
		const panel = new InspectorPanel();
		panel.setExtension(skillRow(20));

		const row = record(
			"inspector skill",
			[...panel.render(80)].find(line => line.includes("dropped")),
		);
		expect(row).toContain("… 5 lines dropped (preview limit)");
		expect(weightOf(row)).toBe(lossWeight());
	});

	it("reports the tool calls a rebuilt branch dropped for having no result", () => {
		const chatContainer = new Container();
		let helpers: UiHelpers;
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "thinking about it" }],
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
			// The marker the context build leaves on a turn whose calls had no result
			// on the resolved path.
			strippedToolCalls: 3,
		};
		const transcript = {
			messages: [message],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		};
		const sessionManager = { getEntries: () => [], getCwd: () => "/repo" };
		const ctx = {
			chatContainer,
			pendingMessagesContainer: new Container(),
			pendingBashComponents: [],
			pendingPythonComponents: [],
			pendingTools: new Map(),
			settledToolCalls: new Set<string>(),
			statusLine: { invalidate: () => {} },
			updateEditorBorderColor: () => {},
			ui: { requestRender: () => {}, imageBudget: undefined },
			resetTranscript: () => chatContainer.clear(),
			settings: { get: () => false },
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			editor: { addToHistory: () => {} },
			viewSession: {
				buildTranscriptSessionContext: () => transcript,
				getToolByName: () => undefined,
				extensionRunner: undefined,
				sessionManager,
			},
			sessionManager,
			addMessageToChat: (msg: Parameters<UiHelpers["addMessageToChat"]>[0]) => helpers.addMessageToChat(msg),
			renderSessionContext: (
				context: Parameters<UiHelpers["renderSessionContext"]>[0],
				options?: Parameters<UiHelpers["renderSessionContext"]>[1],
			) => helpers.renderSessionContext(context, options),
			showStatus: () => {},
			refreshComposerShortcuts: () => {},
			dismissWelcome: () => {},
		} as unknown as InteractiveModeContext;
		helpers = new UiHelpers(ctx);

		helpers.renderInitialMessages();

		const row = record(
			"rebuilt branch",
			chatContainer.render(120).find(line => line.includes("dropped")),
		);
		expect(row).toContain("… 3 tool calls dropped (no result on this branch)");
		expect(weightOf(row)).toBe(lossWeight());
	});

	/**
	 * The set is asserted at the end rather than per arm, so a surface whose row
	 * drifts into a shape of its own — a different mark, a missing count, a cause
	 * outside the parentheses — fails here even if its own arm still finds the
	 * word `dropped`.
	 */
	it("draws every one of those rows in the same shape and the same weight", () => {
		expect(collected.length).toBeGreaterThanOrEqual(6);
		for (const { surface, row } of collected) {
			const stripped = row.replace(/\u001b\[[0-9;]*m/gu, "").trim();
			expect(DROPPED_ROW.exec(stripped)?.groups, `${surface}: ${stripped}`).toBeDefined();
			expect(weightOf(row), surface).toBe(lossWeight());
		}
	});
});

/** A context-file row whose preview is `lines` long, which the panel cuts at 20. */
function contextFileRow(lines: number): ExtensionRow {
	return {
		id: "context-file:AGENTS.md",
		kind: "context-file",
		name: "AGENTS.md",
		displayName: "AGENTS.md",
		path: "/repo/AGENTS.md",
		source: { provider: "project", providerName: "Project", level: "project" },
		state: "active",
		raw: { content: Array.from({ length: lines }, (_, i) => `context line ${i + 1}`).join("\n") },
	};
}

/** A skill row whose instruction is `lines` long, which the panel cuts at 15. */
function skillRow(lines: number): ExtensionRow {
	return {
		id: "skill:demo",
		kind: "skill",
		name: "demo",
		displayName: "demo",
		path: "/repo/skills/demo/SKILL.md",
		source: { provider: "project", providerName: "Project", level: "project" },
		state: "active",
		raw: { prompt: Array.from({ length: lines }, (_, i) => `skill line ${i + 1}`).join("\n") },
	};
}
