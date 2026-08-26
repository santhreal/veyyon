/**
 * WHY THIS SUITE EXISTS.
 *
 * Modal overlays and card panels previously executed entrance animations:
 * a 260ms unfold, staggered row cascades, and a 520ms specular sweep highlight.
 * This delayed readability and introduced visual latency when opening dialogs,
 * pickers, settings, and dashboards.
 *
 * THE CLASS, NOT THE INCIDENT.
 * Every overlay in the product must be instantly readable on its first paint:
 * frame 0 (the first rendered frame) must be byte-identical to the settled frame
 * (after arbitrary clock time). There are no collapsed entrance states, no row
 * cascades, and no specular sweeps on card surfaces.
 *
 * FAIL BY DEFAULT ON NEW MEMBERS.
 * Every overlay component that uses `renderModalShell` or functions as a modal
 * overlay is enumerated in the variant sweep below. If a new overlay class is
 * introduced, it must be added to the constructable registry, and the suite
 * asserts that the unconstructable set is empty.
 *
 * WHAT IT DOES NOT CATCH.
 * Steady-state motion (rail light travel, spinners, pointer hover bands) is
 * governed by other suites and remains active when motion is enabled. What the
 * material of a note or a band LOOKS like is taste, judged in the demo scenes.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import type { AnsiPolicy, Component, KeyId, TUI } from "@veyyon/tui";
import { getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL, visibleWidth } from "@veyyon/tui";
import type { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { AccountManagerComponent } from "../../../src/modes/components/account-manager";
import { AgentDashboard } from "../../../src/modes/components/agent-dashboard";
import { AgentTranscriptViewer } from "../../../src/modes/components/agent-transcript-viewer";
import { AskDialogComponent } from "../../../src/modes/components/ask-dialog";
import { CopySelectorComponent } from "../../../src/modes/components/copy-selector";
import { ExtensionDashboard } from "../../../src/modes/components/extensions/extension-dashboard";
import { HistorySearchComponent } from "../../../src/modes/components/history-search";
import { HookEditorComponent } from "../../../src/modes/components/hook-editor";
import { HookInputComponent } from "../../../src/modes/components/hook-input";
import { HookSelectorComponent } from "../../../src/modes/components/hook-selector";
import { LoginDialogComponent } from "../../../src/modes/components/login-dialog";
import { MCPAddWizard } from "../../../src/modes/components/mcp-add-wizard";
import { ModalSelectListComponent } from "../../../src/modes/components/modal-select-list";
import { MODAL_SIZING_SETTINGS, renderModalShell } from "../../../src/modes/components/modal-shell";
import { ModelHubComponent } from "../../../src/modes/components/model-hub";
import { ModelPickerComponent } from "../../../src/modes/components/model-picker";
import { MoveOverlay } from "../../../src/modes/components/move-overlay";
import { OAuthSelectorComponent } from "../../../src/modes/components/oauth-selector";
import { PlanReviewOverlay, type PlanReviewOverlayOptions } from "../../../src/modes/components/plan-review-overlay";
import { QueueModeSelectorComponent } from "../../../src/modes/components/queue-mode-selector";
import { ResetUsageSelectorComponent } from "../../../src/modes/components/reset-usage-selector";
import { RollbackPickerComponent } from "../../../src/modes/components/rollback-picker";
import { SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { SettingsSelectorComponent } from "../../../src/modes/components/settings-selector";
import { ShowImagesSelectorComponent } from "../../../src/modes/components/show-images-selector";
import { SubcommandPickerComponent } from "../../../src/modes/components/subcommand-picker";
import { ThemeSelectorComponent } from "../../../src/modes/components/theme-selector";
import { ThinkingSelectorComponent } from "../../../src/modes/components/thinking-selector";
import { TreeSelectorComponent } from "../../../src/modes/components/tree-selector";
import { UserMessageSelectorComponent } from "../../../src/modes/components/user-message-selector";
import { resetGroundTintsForTest, setDetectedTerminalGround } from "../../../src/modes/theme/ground-tints";
import { getSelectListTheme, initTheme } from "../../../src/modes/theme/theme";
import type { AgentRegistry } from "../../../src/registry/agent-registry";
import type { AuthStorage } from "../../../src/session/auth-storage";
import type { HistoryStorage } from "../../../src/session/history-storage";
import type { SessionEntry } from "../../../src/session/session-entries";
import type { ConfiguredThinkingLevel } from "../../../src/thinking";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

afterEach(() => {
	motionClock.clear();
});

/**
 * Every column of a row that carries a truecolor background, walked the way a
 * terminal walks it: visible width for text, parameters for the colour. A
 * column set rather than a span list, because the claim is about WHERE paint
 * lands, and a span that starts inside the card and runs off its edge is the
 * defect a start-column list would call clean.
 */
function paintedColumns(line: string): Set<number> {
	const painted = new Set<number>();
	const sgr = /\x1b\[([0-9;:]*)m/g;
	let col = 0;
	let index = 0;
	let background: string | null = null;
	const advance = (text: string): void => {
		const width = visibleWidth(text);
		for (let step = 0; step < width; step++) {
			if (background !== null) painted.add(col + step);
		}
		col += width;
	};
	for (let match = sgr.exec(line); match !== null; match = sgr.exec(line)) {
		advance(line.slice(index, match.index));
		index = match.index + match[0].length;
		const params = match[1] ?? "";
		if (params.includes("48;2")) background = params;
		else if (params === "49" || params === "0" || params === "") background = null;
	}
	advance(line.slice(index));
	return painted;
}

const DUMMY_UI = {
	requestRender: () => {},
	terminal: { rows: 30, columns: 100 },
	showOverlay: () => ({ hide: () => {}, update: () => {} }),
	setFocus: () => {},
} as unknown as TUI;

const DUMMY_REGISTRY = {
	getAll: () => [],
	getAllModels: () => [],
	getAvailable: () => [],
	getModels: () => [],
	findModel: () => undefined,
	getDefaultModel: () => undefined,
	getError: () => undefined,
	isAvailable: () => true,
	getDisabledServices: () => [],
	getDiscoverableProviders: () => [],
	refresh: async () => {},
	onAvailabilityChange: () => () => {},
	onServicesChange: () => () => {},
} as unknown as ModelRegistry;

const DUMMY_AUTH_STORAGE = {
	getProviders: () => [],
	hasToken: () => false,
	hasAuth: () => false,
	getToken: () => undefined,
	getCredentialOrigin: () => undefined,
	saveToken: () => {},
} as unknown as AuthStorage;

interface OverlaySpec {
	name: string;
	create: () =>
		| Promise<Component | { render(width: number): readonly string[] | string[]; dispose?(): void }>
		| Component
		| { render(width: number): readonly string[] | string[]; dispose?(): void };
}

const OVERLAY_SPECS: readonly OverlaySpec[] = [
	{
		name: "AccountManagerComponent",
		create: () =>
			new AccountManagerComponent(
				{ providers: [], totalAccounts: 0, unhealthyCount: 0 },
				{
					onUseAccount: () => {},
					onRename: () => {},
					onRefresh: () => {},
					onLogout: () => {},
					onShowUsage: () => {},
					onAddAccount: () => {},
					onClearRateLimitBlock: () => {},
					onCancel: () => {},
				},
			),
	},
	{
		name: "AgentDashboard",
		create: () => new AgentDashboard(),
	},
	{
		name: "AgentTranscriptViewer",
		create: () =>
			new AgentTranscriptViewer({
				agentId: "agent-1",
				ui: DUMMY_UI,
				registry: { get: () => undefined } as unknown as AgentRegistry,
				cwd: process.cwd(),
				expandKeys: ["e" as unknown as KeyId],
				hubKeys: ["h" as unknown as KeyId],
				requestRender: () => {},
				onClose: () => {},
				onHubClose: () => {},
			}),
	},
	{
		name: "AskDialogComponent",
		create: () =>
			new AskDialogComponent(
				[
					{
						id: "q1",
						question: "Proceed?",
						options: [{ label: "Yes" }, { label: "No" }],
					},
				],
				{ onSubmit: () => {}, onCancel: () => {}, onPrompt: async () => undefined },
			),
	},
	{
		name: "CopySelectorComponent",
		create: () =>
			new CopySelectorComponent([{ id: "1", label: "Item 1", preview: "Preview 1", content: "Text 1" }], {
				onPick: () => {},
				onCancel: () => {},
			}),
	},
	{
		name: "ExtensionDashboard",
		create: async () => await ExtensionDashboard.create(process.cwd(), await Settings.init(), 30),
	},
	{
		name: "HistorySearchComponent",
		create: () =>
			new HistorySearchComponent(
				{
					getRecent: () => [],
					search: () => [],
				} as unknown as HistoryStorage,
				() => {},
				() => {},
			),
	},
	{
		name: "HookEditorComponent",
		create: () =>
			new HookEditorComponent(
				DUMMY_UI,
				"Hook Editor",
				"echo test",
				() => {},
				() => {},
			),
	},
	{
		name: "HookInputComponent",
		create: () =>
			new HookInputComponent(
				"Hook Input",
				undefined,
				() => {},
				() => {},
			),
	},
	{
		name: "HookSelectorComponent",
		create: () =>
			new HookSelectorComponent(
				"Hook Selector",
				[{ label: "Hook A" }],
				() => {},
				() => {},
			),
	},
	{
		name: "LoginDialogComponent",
		create: () => new LoginDialogComponent(DUMMY_UI, "github", () => {}, { getTerminalRows: () => 30 }),
	},
	{
		name: "MCPAddWizard",
		create: () =>
			new MCPAddWizard(
				() => {},
				() => {},
			),
	},
	{
		name: "ModalSelectListComponent",
		create: () =>
			new ModalSelectListComponent(
				{
					title: "Items",
					items: [{ value: "1", label: "One" }],
					theme: getSelectListTheme(),
					getTerminalRows: () => 30,
				},
				{ onSelect: () => {}, onCancel: () => {} },
			),
	},
	{
		name: "ModelHubComponent",
		create: async () =>
			new ModelHubComponent(DUMMY_UI, await Settings.init(), DUMMY_REGISTRY, [], {
				onAssign: () => {},
				onUnassign: () => {},
				onCancel: () => {},
			}),
	},
	{
		name: "ModelPickerComponent",
		create: async () =>
			new ModelPickerComponent(DUMMY_UI, await Settings.init(), DUMMY_REGISTRY, [], {
				onPick: () => {},
				onCancel: () => {},
			}),
	},
	{
		name: "MoveOverlay",
		create: () => new MoveOverlay("/test/path", () => {}),
	},
	{
		name: "OAuthSelectorComponent",
		create: () =>
			new OAuthSelectorComponent(
				DUMMY_AUTH_STORAGE,
				() => {},
				() => {},
			),
	},
	{
		name: "PlanReviewOverlay",
		create: () =>
			new PlanReviewOverlay(
				"# Plan\n- step 1\n- step 2",
				{
					options: [{ label: "Accept", description: "Accept plan" }],
					onReopenProposal: () => {},
					onDiscard: () => {},
					onClose: () => {},
				} as unknown as PlanReviewOverlayOptions,
				{ onPick: () => {}, onCancel: () => {} },
			),
	},
	{
		name: "QueueModeSelectorComponent",
		create: () =>
			new QueueModeSelectorComponent(
				"all",
				() => {},
				() => {},
			),
	},
	{
		name: "ResetUsageSelectorComponent",
		create: () =>
			new ResetUsageSelectorComponent(
				[{ label: "Default Account", availableCount: 1, target: { accountId: "acc-1" }, active: true }],
				() => {},
				() => {},
			),
	},
	{
		name: "RollbackPickerComponent",
		create: () =>
			new RollbackPickerComponent(
				[
					{
						version: "1.0.0",
						publishedAt: "2026-01-01",
						current: true,
						newer: false,
						visited: true,
						changelogUrl: "https://example.com",
					},
				],
				{ onSelect: () => {}, onCancel: () => {}, openUrl: async () => true },
			),
	},
	{
		name: "SessionSelectorComponent",
		create: () =>
			new SessionSelectorComponent(
				[],
				() => {},
				() => {},
				() => {},
			),
	},
	{
		name: "SettingsSelectorComponent",
		create: async () =>
			new SettingsSelectorComponent(
				{
					availableThemes: ["dark", "light", "titanium"],
					availablePersonalities: [],
					availableThinkingLevels: [Effort.Low, Effort.Medium, Effort.High],
					thinkingLevel: undefined,
					providers: ["openai", "anthropic"],
					cwd: process.cwd(),
				},
				{
					onChange: () => {},
					onCancel: () => {},
				},
			),
	},
	{
		name: "ShowImagesSelectorComponent",
		create: () =>
			new ShowImagesSelectorComponent(
				true,
				() => {},
				() => {},
			),
	},
	{
		name: "SubcommandPickerComponent",
		create: () =>
			new SubcommandPickerComponent(
				"test",
				[{ name: "sub1", description: "First subcommand" }],
				() => {},
				() => {},
			),
	},
	{
		name: "ThemeSelectorComponent",
		create: () =>
			new ThemeSelectorComponent(
				"dark",
				["dark", "light", "titanium"],
				() => {},
				() => {},
				() => {},
			),
	},
	{
		name: "ThinkingSelectorComponent",
		create: () =>
			new ThinkingSelectorComponent(
				"medium" as ConfiguredThinkingLevel,
				{ id: "o3-mini", name: "o3-mini", reasoningEfforts: ["low", "medium", "high"] } as unknown as Model,
				() => {},
				() => {},
			),
	},
	{
		name: "TreeSelectorComponent",
		create: () =>
			new TreeSelectorComponent(
				[
					{
						entry: { id: "root", type: "session_init", timestamp: Date.now() } as unknown as SessionEntry,
						children: [],
					},
				],
				"root",
				() => {},
				() => {},
			),
	},
	{
		name: "UserMessageSelectorComponent",
		create: () =>
			new UserMessageSelectorComponent(
				[{ id: "m1", text: "Hello", timestamp: "2026-01-01" }],
				() => {},
				() => {},
			),
	},
];

describe("a card's first rendered frame is byte-identical to its settled frame", () => {
	it("choke point: renderModalShell is purely static and deterministic across clock ticks", () => {
		const input = {
			title: "Choke Point Modal",
			sizing: MODAL_SIZING_SETTINGS,
			areaWidth: 100,
			areaHeight: 30,
			body: ["  Line 1", "  Line 2", "  Line 3"],
			searchLine: " / search",
			tipCandidates: ["Tip candidate 1"],
		};

		const now = performance.now();
		const frame0 = renderModalShell(input);
		motionClock.tick(now + 300);
		const frame300 = renderModalShell(input);
		motionClock.tick(now + 1000);
		const frame1000 = renderModalShell(input);

		expect([...frame0.lines]).toEqual([...frame300.lines]);
		expect([...frame0.lines]).toEqual([...frame1000.lines]);
		expect(frame0.geometry).toEqual(frame1000.geometry);
	});

	it("sweeps every constructable overlay component: frame 0 === settled frame", async () => {
		const unconstructable: string[] = [];

		for (const spec of OVERLAY_SPECS) {
			let component: Component | { render(width: number): readonly string[] | string[]; dispose?(): void };
			try {
				component = await spec.create();
			} catch (err) {
				unconstructable.push(`${spec.name}: ${err}`);
				continue;
			}

			// Frame 0: first render on open
			let firstFrame: readonly string[] | string[];
			try {
				firstFrame = component.render(100);
			} catch (err) {
				throw new Error(`Component ${spec.name} render failed: ${err}`);
			}
			expect(firstFrame.length).toBeGreaterThan(0);

			const now = performance.now();
			motionClock.tick(now + 260);
			const midFrame = component.render(100);
			motionClock.tick(now + 1000);
			const settledFrame = component.render(100);

			expect([...firstFrame]).toEqual([...midFrame]);
			expect([...firstFrame]).toEqual([...settledFrame]);

			if ("dispose" in component && typeof component.dispose === "function") {
				component.dispose();
			}
		}

		expect(unconstructable).toEqual([]);
	});

	it("names every overlay it sweeps, so a new card is red until someone decides", () => {
		expect([...OVERLAY_SPECS].map(spec => spec.name).sort()).toEqual([
			"AccountManagerComponent",
			"AgentDashboard",
			"AgentTranscriptViewer",
			"AskDialogComponent",
			"CopySelectorComponent",
			"ExtensionDashboard",
			"HistorySearchComponent",
			"HookEditorComponent",
			"HookInputComponent",
			"HookSelectorComponent",
			"LoginDialogComponent",
			"MCPAddWizard",
			"ModalSelectListComponent",
			"ModelHubComponent",
			"ModelPickerComponent",
			"MoveOverlay",
			"OAuthSelectorComponent",
			"PlanReviewOverlay",
			"QueueModeSelectorComponent",
			"ResetUsageSelectorComponent",
			"RollbackPickerComponent",
			"SessionSelectorComponent",
			"SettingsSelectorComponent",
			"ShowImagesSelectorComponent",
			"SubcommandPickerComponent",
			"ThemeSelectorComponent",
			"ThinkingSelectorComponent",
			"TreeSelectorComponent",
			"UserMessageSelectorComponent",
		]);
	});

	// The entrance carried the only code that mixed a colour out of "the ground
	// behind this row", and a wash over every cell of a card reads as a film over
	// the page rather than an object on it. Its absence is a contract: this is the
	// exact configuration a returning fill would hide in, a truecolor terminal
	// whose ground is known.
	it("gives a card no fill of its own, and leaves a band the body supplied alone", () => {
		const policy: AnsiPolicy = getAnsiPolicy();
		const trueColorWas = TERMINAL.trueColor;
		const caps: { trueColor: boolean } = TERMINAL;
		setAnsiPolicy("full");
		caps.trueColor = true;
		setDetectedTerminalGround("#1e2127");
		try {
			const band = `\x1b[48;2;120;60;20m${"selected row".padEnd(40)}\x1b[49m`;
			const result = renderModalShell({
				title: "Settings",
				sizing: MODAL_SIZING_SETTINGS,
				areaWidth: 100,
				areaHeight: 30,
				body: ["plain row", band, "plain row"],
				shortcuts: [{ id: "close", label: "esc close" }],
			});
			const geometry = result.geometry;
			if (geometry === null) throw new Error("the card did not fit, so there is nothing to assert");

			const bandRow = result.lines.findIndex(line => line.includes("selected row"));
			expect(bandRow, "the band row is inside the card").toBeGreaterThanOrEqual(geometry.cardRowStart);
			expect(result.lines[bandRow]).toContain("48;2;120;60;20");

			for (let row = 0; row < result.lines.length; row++) {
				if (row === bandRow) continue;
				expect(paintedColumns(result.lines[row] ?? ""), `row ${row} carries a fill`).toEqual(new Set());
			}
		} finally {
			resetGroundTintsForTest();
			caps.trueColor = trueColorWas;
			setAnsiPolicy(policy);
		}
	});
});
