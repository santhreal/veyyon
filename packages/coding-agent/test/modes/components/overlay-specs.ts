/**
 * Every floating card in the product, constructed the way a suite that sweeps all of them needs.
 *
 * ONE OWNER FOR THE ROSTER. Two suites make a claim about "every overlay": one that a card's first
 * frame is its settled frame, one that no rule inside a card is painted in the accent. A second copy
 * of this list would let a new card satisfy one sweep and never enter the other, which is the exact
 * shape of the defect both suites exist to catch. `a-card-first-frame-is-settled.test.ts` holds the
 * literal roll-call of names, so adding a card without listing it there is red, and listing it there
 * puts it into every sweep that reads this module.
 *
 * A spec constructs its component with the narrowest input that renders: empty collections where the
 * card tolerates them, one row where it does not. `create` may be async because a few cards need
 * `Settings.init()`.
 */

import type { Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import type { Component, KeyId, TUI } from "@veyyon/tui";
import type { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { AccountManagerComponent } from "../../../src/modes/components/account-manager";
import { AdvisorConfigOverlayComponent } from "../../../src/modes/components/advisor-config";
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
import { getSelectListTheme } from "../../../src/modes/theme/theme";
import type { AgentRegistry } from "../../../src/registry/agent-registry";
import type { AuthStorage } from "../../../src/session/auth-storage";
import type { HistoryStorage } from "../../../src/session/history-storage";
import type { SessionEntry } from "../../../src/session/session-entries";
import type { ConfiguredThinkingLevel } from "../../../src/thinking";

export const DUMMY_UI = {
	requestRender: () => {},
	terminal: { rows: 30, columns: 100 },
	showOverlay: () => ({ hide: () => {}, update: () => {} }),
	setFocus: () => {},
} as unknown as TUI;

/**
 * Two models over two providers, because a card that groups by provider draws its group separator
 * only when there is more than one group, and an empty registry hid those rows from every sweep.
 */
const DUMMY_MODELS: readonly Model[] = [
	{
		id: "alpha-1",
		name: "Alpha 1",
		api: "openai-completions",
		provider: "alpha",
		baseUrl: "https://alpha.example",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		pricing: "published",
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		id: "beta-1",
		name: "Beta 1",
		api: "openai-completions",
		provider: "beta",
		baseUrl: "https://beta.example",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 },
		pricing: "published",
		contextWindow: 64_000,
		maxTokens: 4_096,
	},
] as unknown as readonly Model[];

export const DUMMY_AUTH_STORAGE = {
	getProviders: () => [],
	hasToken: () => false,
	hasAuth: () => false,
	getToken: () => undefined,
	getCredentialOrigin: () => undefined,
	saveToken: () => {},
} as unknown as AuthStorage;

export const DUMMY_REGISTRY = {
	getAll: () => DUMMY_MODELS,
	getAllModels: () => DUMMY_MODELS,
	getAvailable: () => DUMMY_MODELS,
	getModels: () => DUMMY_MODELS,
	findModel: () => undefined,
	getDefaultModel: () => DUMMY_MODELS[0],
	getError: () => undefined,
	isAvailable: () => true,
	getDisabledServices: () => [],
	getDiscoverableProviders: () => [],
	authStorage: DUMMY_AUTH_STORAGE,
	refresh: async () => {},
	onAvailabilityChange: () => () => {},
	onServicesChange: () => () => {},
} as unknown as ModelRegistry;

/** A card a sweep can render: `render(width)` and, where it holds motion, `dispose()`. */
export type RenderableOverlay = Component | { render(width: number): readonly string[] | string[]; dispose?(): void };

export interface OverlaySpec {
	name: string;
	create: () => Promise<RenderableOverlay> | RenderableOverlay;
	/**
	 * Raw key sequences a sweep may send before rendering, to reach a pane a freshly opened card does
	 * not show. Data rather than a callback, so a suite whose claim is about the FIRST frame ignores
	 * it while a suite that has to see every rule sends it.
	 */
	reachKeys?: readonly string[];
}

export const OVERLAY_SPECS: readonly OverlaySpec[] = [
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
		/**
		 * The only consumer of the SPLIT chrome builders (`topBorderSplit` / `dividerSplit` /
		 * `splitRow`), and the reason it is here: a rule welded back into the frame by the split
		 * builders was invisible to every sweep while this card was missing from the roster, even
		 * though the sibling builders it shares a module with were covered three times over.
		 */
		name: "AdvisorConfigOverlayComponent",
		create: () =>
			new AdvisorConfigOverlayComponent(
				DUMMY_UI,
				{
					modelRegistry: DUMMY_REGISTRY,
					settings: {} as unknown as Settings,
					scopedModels: [],
					availableToolNames: ["read", "search"],
				},
				"project",
				{ instructions: "shared baseline", advisors: [{ name: "Architecture" }, { name: "Security" }] },
				{
					loadDoc: async () => ({ advisors: [] }),
					save: async () => {},
					close: () => {},
					requestRender: () => {},
					notify: () => {},
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
						// The highlighted option carries a preview, which is what opens the dialog's
						// second pane and the rule between the two. Without it the rule never renders.
						options: [{ label: "Yes", preview: "What accepting does.\nA second line." }, { label: "No" }],
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
		// Left focuses the scope column, up hops from "All models" to "Roles": the roles pane draws
		// its own separator row, which no other state of this card shows.
		reachKeys: ["\x1b[D", "\x1b[A"],
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
				// Several sections, because the card shows its table of contents — and the rule
				// between it and the body — only for a plan that has more than one.
				"# Plan\n\n## Step one\n\n- do a thing\n\n## Step two\n\n- do another\n\n## Step three\n\n- and a third\n",
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
