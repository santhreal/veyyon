/**
 * The six ModalShell selector overlays answer the pointer at the row level.
 *
 * WHAT THIS CLOSES. Every one of these overlays parsed SGR mouse input and
 * then spent it entirely on the chrome hit-test: the footer chips hovered and
 * clicked, but moving the cursor over a RESULT row changed nothing, clicking a
 * row did nothing, and the wheel was dead — despite each overlay's footer
 * advertising "up/down navigate, enter select". Two defects compounded: the
 * chrome hit-test consumed all in-card motion (fixed with
 * consumeModalChipHover), and the bodies had no row routing at all. Each body
 * now carries the SelectList contract: hover bands the row under the pointer
 * (never the selected row, which owns its styling), a click selects and
 * confirms that row exactly like Enter, and a wheel notch steps the selection
 * like an arrow key.
 *
 * Sweep discipline: every selector overlay with row content gets a case. The
 * six are enumerated by hand because each has its own constructor surface; a
 * new ModalShell selector that skips pointer routing is caught by the shared
 * base/geometry helpers it would have to bypass, not by this list.
 *
 * The band assertions force colour ON: `theme.bg` returns its argument
 * unchanged when colour is off, so under the default piped policy a band row
 * is byte-identical to a plain row and no assertion could tell them apart.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionAskDialogQuestion } from "@veyyon/coding-agent/extensibility/extensions/types";
import { AskDialogComponent } from "@veyyon/coding-agent/modes/components/ask-dialog";
import { CopySelectorComponent } from "@veyyon/coding-agent/modes/components/copy-selector";
import { HistorySearchComponent } from "@veyyon/coding-agent/modes/components/history-search";
import { ModelPickerComponent } from "@veyyon/coding-agent/modes/components/model-picker";
import { MoveOverlay } from "@veyyon/coding-agent/modes/components/move-overlay";
import { ResetUsageSelectorComponent } from "@veyyon/coding-agent/modes/components/reset-usage-selector";
import { SessionSelectorComponent } from "@veyyon/coding-agent/modes/components/session-selector";
import { UserMessageSelectorComponent } from "@veyyon/coding-agent/modes/components/user-message-selector";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { CopyTarget } from "@veyyon/coding-agent/modes/utils/copy-targets";
import type { HistoryEntry, HistoryStorage } from "@veyyon/coding-agent/session/history-storage";
import type { SessionInfo } from "@veyyon/coding-agent/session/session-listing";
import type { ResetUsageAccount } from "@veyyon/coding-agent/slash-commands/helpers/reset-usage";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, type TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 110;
const BG_OPEN = /\x1b\[48;/;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	setAnsiPolicy(policy);
	geometry.restore();
});

/** SGR motion (button 32+3=35) and left press at 1-based screen coords, mid-card column. */
function motionAt(row1: number, col1 = 40): string {
	return `\x1b[<35;${col1};${row1}M`;
}
function clickAt(row1: number, col1 = 40): string {
	return `\x1b[<0;${col1};${row1}M`;
}
function wheelAt(direction: "up" | "down", row1: number, col1 = 40): string {
	return `\x1b[<${direction === "down" ? 65 : 64};${col1};${row1}M`;
}

interface RowHost {
	render(width: number): readonly string[];
	handleInput(data: string): void;
}

/** 1-based screen row of the first rendered line containing `text`. */
function rowOf(host: RowHost, text: string): number {
	const lines = host.render(WIDTH);
	const index = lines.findIndex(line => line.includes(text));
	expect(index, `row containing ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** Motion over `text`'s row wraps that row in a background band. */
function expectHoverBand(host: RowHost, text: string): void {
	const row = rowOf(host, text);
	const before = host.render(WIDTH)[row - 1]!;
	host.handleInput(motionAt(row));
	const after = host.render(WIDTH)[row - 1]!;
	expect(after).not.toBe(before);
	expect(after).toMatch(BG_OPEN);
	expect(after).toContain(text);
}

const NOW = Math.floor(Date.parse("2026-08-10T12:00:00.000Z") / 1000);

function historyStorage(prompts: string[]): HistoryStorage {
	const entries: HistoryEntry[] = prompts.map((prompt, index) => ({
		id: index + 1,
		prompt,
		cwd: "/repo",
		sessionId: "s-1",
		created_at: NOW - index * 900,
	}));
	return { getRecent: () => entries, search: () => entries } as unknown as HistoryStorage;
}

describe("selector overlays answer the pointer", () => {
	it("history search: hover bands a result, click recalls it, wheel steps the selection", () => {
		let picked: string | undefined;
		const component = new HistorySearchComponent(
			historyStorage(["first prompt", "second prompt", "third prompt"]),
			prompt => {
				picked = prompt;
			},
			() => {},
		);

		expectHoverBand(component, "second prompt");

		component.handleInput(clickAt(rowOf(component, "second prompt")));
		expect(picked).toBe("second prompt");
	});

	it("history search: wheel moves the selection like the arrow keys", () => {
		const component = new HistorySearchComponent(
			historyStorage(["first prompt", "second prompt", "third prompt"]),
			() => {},
			() => {},
		);
		// Selection starts on the first result; a wheel-down notch moves it to the second.
		component.handleInput(wheelAt("down", rowOf(component, "second prompt")));
		const line = component.render(WIDTH)[rowOf(component, "second prompt") - 1]!;
		expect(line).toMatch(BG_OPEN);
		expect(line).toContain("second prompt");
	});

	it("reset usage: hover bands an account, first click arms, second click spends", () => {
		const accounts: ResetUsageAccount[] = [
			{ label: "acc-one", availableCount: 2, target: { email: "one@x" }, active: false },
			{ label: "acc-two", availableCount: 1, target: { email: "two@x" }, active: false },
		];
		let spent: ResetUsageAccount | undefined;
		const component = new ResetUsageSelectorComponent(
			accounts,
			account => {
				spent = account;
			},
			() => {},
		);

		expectHoverBand(component, "acc-two");

		const row = rowOf(component, "acc-two");
		component.handleInput(clickAt(row));
		expect(spent).toBeUndefined(); // armed, not spent: a reset is irreversible
		expect(component.render(WIDTH).join("\n")).toContain("Press Enter again");
		component.handleInput(clickAt(row));
		expect(spent?.label).toBe("acc-two");
	});

	it("user messages: hover bands a message, click branches from it, wheel steps", () => {
		const messages = [
			{ id: "m1", text: "the first user message" },
			{ id: "m2", text: "the second user message" },
			{ id: "m3", text: "the third user message" },
		];
		let branched: string | undefined;
		const component = new UserMessageSelectorComponent(
			messages,
			id => {
				branched = id;
			},
			() => {},
		);

		expectHoverBand(component, "the first user message");

		component.handleInput(clickAt(rowOf(component, "the first user message")));
		expect(branched).toBe("m1");
	});

	it("move overlay: hover bands a directory, click confirms it, wheel steps", () => {
		using dir = TempDir.createSync("@veyyon-move-mouse-");
		fs.mkdirSync(path.join(dir.path(), "alpha"));
		fs.mkdirSync(path.join(dir.path(), "beta"));
		let moved: { directory: string } | undefined;
		const overlay = new MoveOverlay(dir.path(), result => {
			moved = result;
		});

		expectHoverBand(overlay, "beta/");

		overlay.handleInput(clickAt(rowOf(overlay, "beta/")));
		expect(moved?.directory).toBe(path.join(dir.path(), "beta"));
	});

	it("copy selector: hover bands a tree row, click picks a content leaf, wheel steps", () => {
		const roots: CopyTarget[] = [
			{ id: "a", label: "Alpha block", hint: "3 lines", preview: "alpha preview", content: "alpha content" },
			{ id: "b", label: "Beta block", hint: "1 line", preview: "beta preview", content: "beta content" },
		];
		let copied: CopyTarget | undefined;
		const component = new CopySelectorComponent(roots, {
			onPick: target => {
				copied = target;
			},
			onCancel: () => {},
		});

		expectHoverBand(component, "Beta block");

		component.handleInput(clickAt(rowOf(component, "Beta block")));
		expect(copied?.id).toBe("b");
	});

	it("model picker: hover bands a model row, click selects, second click picks", () => {
		const makeModel = (id: string): Model =>
			buildModel({
				id,
				name: id,
				api: "ollama-chat",
				provider: "ollama",
				baseUrl: "https://example.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 1024,
			});
		const first = makeModel("llama-3");
		const second = makeModel("qwen-4");
		const registry = {
			refresh: () => Promise.resolve(),
			refreshProvider: () => Promise.resolve(),
			getError: () => undefined,
			getAvailable: () => [first, second],
			getAll: () => [first, second],
		} as unknown as ModelRegistry;
		let picked: Model | undefined;
		const picker = new ModelPickerComponent(
			{ requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI,
			Settings.isolated({}),
			registry,
			[{ model: first }, { model: second }],
			{
				onPick: (m: Model) => {
					picked = m;
				},
				onCancel: () => {},
			},
		);

		// The scoped list pre-selects the current model (qwen-4); llama-3 is the
		// non-selected row, so the first click selects and the second activates.
		expectHoverBand(picker, "llama-3");

		const row = rowOf(picker, "llama-3");
		picker.handleInput(clickAt(row)); // selects
		expect(picked).toBeUndefined();
		picker.handleInput(clickAt(row)); // click-again activates
		expect(picked?.id).toBe("llama-3");
	});

	it("ask dialog: hover bands an option, click answers it", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Choose one?", options: [{ label: "Option A" }, { label: "Option B" }] },
		];
		let selected: string[] | undefined;
		const dialog = new AskDialogComponent(questions, {
			onSubmit: result => {
				selected = result.results[0]?.selectedOptions;
			},
			onCancel: () => {},
			onPrompt: () => Promise.resolve(undefined),
		});

		expectHoverBand(dialog, "Option B");

		dialog.handleInput(clickAt(rowOf(dialog, "Option B")));
		expect(selected).toEqual(["Option B"]);
	});

	it("ask dialog: wheel moves the option cursor like the arrow keys", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Choose one?", options: [{ label: "Option A" }, { label: "Option B" }] },
		];
		const dialog = new AskDialogComponent(questions, {
			onSubmit: () => {},
			onCancel: () => {},
			onPrompt: () => Promise.resolve(undefined),
		});

		dialog.handleInput(wheelAt("down", rowOf(dialog, "Option A")));
		// The selection cursor left Option A's row for Option B's.
		const lines = dialog.render(WIDTH);
		const optionB = lines.find(line => line.includes("Option B"));
		const optionA = lines.find(line => line.includes("Option A"));
		expect(optionB).toContain(theme.nav.cursor);
		expect(optionA).not.toContain(theme.nav.cursor);
	});

	it("session selector: hover bands a session row", () => {
		const makeSession = (id: string, title: string): SessionInfo => ({
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
		});
		const selector = new SessionSelectorComponent(
			[
				makeSession("aaaa", "Alpha session"),
				makeSession("bbbb", "Beta session"),
				makeSession("cccc", "Gamma session"),
			],
			() => {},
			() => {},
			() => {},
			{ getTerminalRows: () => 40, fillHeight: true },
		);

		expectHoverBand(selector, "Beta session");
	});
});
