/**
 * WHY. Every ModalShell host re-typed the chrome half of its mouse routing: hit-test the shell,
 * fold chip hover, cancel on the close glyph or a click outside, act on the `confirm` chip. Copies
 * of one prelude are how a host drifts: one drops the outside-click cancel, another answers the
 * confirm chip with a private copy of the action instead of the key it names. Every host now
 * shares `routeModalChrome`; this suite drives four of them through the REAL component and asserts
 * the observable contract of that prelude rather than the helper's return value.
 *
 * THE CLASS. Every host that routes the pointer through the shared prelude answers a click on its
 * `close` chip and a click outside the card with its cancel callback, answers its `confirm` chip
 * with its submit path, and does not treat pointer motion over a chip as a click. The hosts are
 * listed by name because each needs its own constructor. The other hosts on the prelude are
 * pinned by their own pointer suites: the session tree, session, settings (breadcrumb and
 * submenu), model hub, model picker, transcript, agent dashboard, plan review, login, ask, MCP
 * wizard and plugins cards each have an `…answers-the-pointer` or `…-mouse` suite that clicks the
 * same chrome through the same router.
 *
 * NOT CAUGHT. Body-row routing, which each host owns and its own suite covers. A chip other than
 * `close`/`confirm`, whose meaning is the host's (`onShortcut`), and the two host-specific
 * options — `onCloseChip` (the model picker's cancel ladder) and `onBreadcrumb` (settings) —
 * which those hosts' suites exercise.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionAskDialogQuestion } from "@veyyon/coding-agent/extensibility/extensions/types";
import {
	type AccountManagerCallbacks,
	AccountManagerComponent,
} from "@veyyon/coding-agent/modes/terminal/components/account/account-manager";
import { HistorySearchComponent } from "@veyyon/coding-agent/modes/terminal/components/composer/history-search";
import { AskDialogComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/ask-dialog";
import { HookEditorComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/hook-editor";
import { HookInputComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/hook-input";
import { ModelPickerComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/model-picker";
import type { AccountInventory } from "@veyyon/coding-agent/session/account-inventory";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { HistoryEntry, HistoryStorage } from "@veyyon/kernel/session/history-storage";
import type { TUI } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const WIDTH = 110;
const ROWS = 40;

let geometry: StubbedStdoutGeometry;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: ROWS });
});

afterEach(() => {
	geometry.restore();
	vi.restoreAllMocks();
});

/** SGR left press, motion (button 32+3) at 1-based screen coordinates. */
function clickAt(row1: number, col1: number): string {
	return `\x1b[<0;${col1};${row1}M`;
}
function motionAt(row1: number, col1: number): string {
	return `\x1b[<35;${col1};${row1}M`;
}

interface Host {
	render(width: number): readonly string[];
	handleInput(data: string): void;
}

interface Arm {
	host: Host;
	/** Text of the `close` chip as painted. */
	closeChip: string;
	/** Text of the `confirm` chip as painted. */
	confirmChip: string;
	cancels: () => number;
	confirms: () => number;
}

/** 1-based screen row and column of the first painted occurrence of `text`. */
function locate(host: Host, text: string): { row1: number; col1: number } {
	const lines = host.render(WIDTH).map(line => stripVTControlCharacters(line));
	const index = lines.findIndex(line => line.includes(text));
	expect(index, `a row containing ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
	return { row1: index + 1, col1: lines[index]!.indexOf(text) + 1 };
}

/** A 1-based screen cell outside the card: the blank top padding, or the blank left margin. */
function outside(host: Host): { row1: number; col1: number } {
	const lines = host.render(WIDTH).map(line => stripVTControlCharacters(line));
	const firstPainted = lines.findIndex(line => line.trim().length > 0);
	expect(firstPainted, "a painted row").toBeGreaterThanOrEqual(0);
	if (firstPainted > 0) return { row1: 1, col1: 1 };
	const margin = lines[firstPainted]!.length - lines[firstPainted]!.trimStart().length;
	expect(margin, "a blank margin left of the card").toBeGreaterThan(0);
	return { row1: firstPainted + 1, col1: 1 };
}

function tui(): TUI {
	return {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: WIDTH },
	} as unknown as TUI;
}

function historyStorage(prompts: string[]): HistoryStorage {
	const entries: HistoryEntry[] = prompts.map((prompt, index) => ({
		id: index + 1,
		prompt,
		cwd: "/repo",
		sessionId: "s-1",
		created_at: 1_700_000_000 - index * 900,
	}));
	return { getRecent: () => entries, search: () => entries } as unknown as HistoryStorage;
}

function ollamaModel(id: string): Model {
	return buildModel({
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
}

function modelPicker(callbacks: { onPick: (model: Model) => void; onCancel: () => void }): ModelPickerComponent {
	const models = [ollamaModel("llama-3"), ollamaModel("qwen-4")];
	const registry = {
		refresh: () => Promise.resolve(),
		refreshProvider: () => Promise.resolve(),
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
	} as unknown as ModelRegistry;
	return new ModelPickerComponent(
		{ ...tui(), terminal: { columns: WIDTH, rows: ROWS } } as unknown as TUI,
		Settings.isolated({}),
		registry,
		models.map(model => ({ model })),
		callbacks,
	);
}

const INVENTORY: AccountInventory = {
	providers: [
		{
			provider: "anthropic",
			label: "Anthropic",
			rows: [
				{
					provider: "anthropic",
					providerLabel: "Anthropic",
					credentialId: 1,
					type: "oauth",
					origin: { kind: "oauth" },
					usage: [],
					activeForSession: true,
					activeIsPrediction: false,
					selectedForProvider: true,
				},
			],
		},
	],
	totalAccounts: 1,
	unhealthyCount: 0,
};

const ARMS: Record<string, () => Arm> = {
	"hook editor": () => {
		let cancels = 0;
		let confirms = 0;
		const host = new HookEditorComponent(
			tui(),
			"Prompt",
			"draft",
			() => {
				confirms += 1;
			},
			() => {
				cancels += 1;
			},
		);
		return { host, closeChip: "esc cancel", confirmChip: "submit", cancels: () => cancels, confirms: () => confirms };
	},
	"hook input": () => {
		let cancels = 0;
		let confirms = 0;
		const host = new HookInputComponent(
			"Prompt",
			undefined,
			() => {
				confirms += 1;
			},
			() => {
				cancels += 1;
			},
			{ tui: tui() },
		);
		return { host, closeChip: "cancel", confirmChip: "submit", cancels: () => cancels, confirms: () => confirms };
	},
	"history search": () => {
		let cancels = 0;
		let confirms = 0;
		const host = new HistorySearchComponent(
			historyStorage(["first prompt", "second prompt"]),
			() => {
				confirms += 1;
			},
			() => {
				cancels += 1;
			},
		);
		return { host, closeChip: "close", confirmChip: "select", cancels: () => cancels, confirms: () => confirms };
	},
	"account manager": () => {
		let cancels = 0;
		let confirms = 0;
		// The `enter` chip activates the selected body row, which is either an account (`onUseAccount`)
		// or the add entry (`onAddAccount`); both are the confirm path.
		const callbacks: AccountManagerCallbacks = {
			onUseAccount: () => {
				confirms += 1;
			},
			onRename: () => {},
			onRefresh: () => {},
			onLogout: () => {},
			onShowUsage: () => {},
			onAddAccount: () => {
				confirms += 1;
			},
			onClearRateLimitBlock: () => {},
			onCancel: () => {
				cancels += 1;
			},
		};
		const host = new AccountManagerComponent(INVENTORY, callbacks, {});
		return { host, closeChip: "esc close", confirmChip: "enter ", cancels: () => cancels, confirms: () => confirms };
	},
	"ask dialog": () => {
		let cancels = 0;
		let confirms = 0;
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Choose one?", options: [{ label: "Option A" }, { label: "Option B" }] },
		];
		const host = new AskDialogComponent(questions, {
			onSubmit: () => {
				confirms += 1;
			},
			onCancel: () => {
				cancels += 1;
			},
			onPrompt: () => Promise.resolve(undefined),
		});
		return {
			host,
			closeChip: "esc cancel",
			confirmChip: "enter select",
			cancels: () => cancels,
			confirms: () => confirms,
		};
	},
	"model picker": () => {
		let cancels = 0;
		let confirms = 0;
		const host = modelPicker({
			onPick: () => {
				confirms += 1;
			},
			onCancel: () => {
				cancels += 1;
			},
		});
		return {
			host,
			closeChip: "esc close",
			confirmChip: "enter use",
			cancels: () => cancels,
			confirms: () => confirms,
		};
	},
};

describe("a modal dialog answers its chrome through one router", () => {
	const names = Object.keys(ARMS).sort();

	it("covers every host that routes through the shared prelude", () => {
		expect(names).toEqual([
			"account manager",
			"ask dialog",
			"history search",
			"hook editor",
			"hook input",
			"model picker",
		]);
	});

	describe.each(names)("%s", name => {
		it("cancels on a click on its close chip", () => {
			const arm = ARMS[name]!();
			const at = locate(arm.host, arm.closeChip);
			arm.host.handleInput(clickAt(at.row1, at.col1));
			expect(arm.cancels()).toBe(1);
			expect(arm.confirms()).toBe(0);
		});

		it("cancels on a click outside the card", () => {
			const arm = ARMS[name]!();
			const at = outside(arm.host);
			arm.host.handleInput(clickAt(at.row1, at.col1));
			expect(arm.cancels()).toBe(1);
			expect(arm.confirms()).toBe(0);
		});

		it("submits on a click on its confirm chip", () => {
			const arm = ARMS[name]!();
			const at = locate(arm.host, arm.confirmChip);
			arm.host.handleInput(clickAt(at.row1, at.col1));
			expect(arm.confirms()).toBe(1);
			expect(arm.cancels()).toBe(0);
		});

		it("treats motion over a chip as hover, not as a click", () => {
			const arm = ARMS[name]!();
			const close = locate(arm.host, arm.closeChip);
			const confirm = locate(arm.host, arm.confirmChip);
			arm.host.handleInput(motionAt(close.row1, close.col1));
			arm.host.handleInput(motionAt(confirm.row1, confirm.col1));
			expect(arm.cancels()).toBe(0);
			expect(arm.confirms()).toBe(0);
		});
	});

	it("the model picker's esc chip clears a live query before it closes the card", () => {
		let cancels = 0;
		const host = modelPicker({ onPick: () => {}, onCancel: () => (cancels += 1) });
		host.handleInput("lla");
		expect(stripVTControlCharacters(host.render(WIDTH).join("\n"))).toContain("esc clear");
		const clear = locate(host, "esc clear");
		host.handleInput(clickAt(clear.row1, clear.col1));
		expect(cancels).toBe(0);
		const painted = stripVTControlCharacters(host.render(WIDTH).join("\n"));
		expect(painted).not.toContain("esc clear");
		expect(painted).toContain("esc close");
		const close = locate(host, "esc close");
		host.handleInput(clickAt(close.row1, close.col1));
		expect(cancels).toBe(1);
	});

	it("a click outside the model picker is a hard close even while a query is live", () => {
		let cancels = 0;
		const host = modelPicker({ onPick: () => {}, onCancel: () => (cancels += 1) });
		host.handleInput("lla");
		const at = outside(host);
		host.handleInput(clickAt(at.row1, at.col1));
		expect(cancels).toBe(1);
	});
});
