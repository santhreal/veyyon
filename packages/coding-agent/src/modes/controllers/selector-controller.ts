import { ThinkingLevel } from "@veyyon/agent-core";
import type { InstrumentationLevel } from "@veyyon/ai/instrumentation";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import type { OAuthProvider } from "@veyyon/ai/oauth/types";
// The derived provider set from the registry that derives it (164 modules) rather than the
// barrel (346).
import { PASTE_CODE_LOGIN_PROVIDERS } from "@veyyon/ai/registry/derived";
import type { Component, OverlayHandle } from "@veyyon/tui";
import { Loader, Spacer, setTuiTight, Text } from "@veyyon/tui";
import { errorMessage, getActiveAuthDbPath, getProjectDir, normalizePathForComparison } from "@veyyon/utils";
import * as logger from "@veyyon/utils/logger";
import { isRollbackSupported, rollbackToVersion } from "../../cli/update-cli";
import { formatModelSelectorValue } from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT, getRoleInfo, isDefaultModelSlot } from "../../config/model-roles";
import { applySamplingKnob, optionalNumber, toNumberOrUndefined } from "../../config/optional-number";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../config/settings-instance";
import { disableProvider, enableProvider } from "../../discovery";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { setMarkdownMermaidRendering } from "../../modes/theme/markdown-theme";
import {
	FALLBACK_THEME_NAME,
	getAvailableThemes,
	getSymbolTheme,
	previewTheme,
	setColorBlindMode,
	setSymbolPreset,
	setTheme,
	type ThemeLoadResult,
	theme,
} from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { resolveAvailablePersonalities } from "../../personality/resolver";
import {
	accountDisplayLabel,
	applyCredentialHealth,
	applyUsageReports,
	buildAccountInventory,
	loadAccountInventory,
} from "../../session/account-inventory";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "../../session/auth-storage";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { formatProviderName } from "../../slash-commands/helpers/format";
import { type LogoutAccount, toLogoutAccounts } from "../../slash-commands/helpers/logout";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "../../slash-commands/helpers/reset-usage";
import type { SubcommandDef } from "../../slash-commands/types";
import { frozenGateNotice, isLivePromptGate } from "../../system-prompt-builder/gate-registry";
import { type ConfiguredThinkingLevel, hasConfigurableThinkingEffort } from "../../thinking";
import { isImageProviderPreference, setPreferredImageProvider } from "../../tools/image-gen";
import { shortenPath } from "../../tools/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import {
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "../../web/search";
import { AccountManagerComponent } from "../components/account-manager";
import { AgentDashboard } from "../components/agent-dashboard";
import { AssistantMessageComponent } from "../components/assistant-message";
import { CopySelectorComponent } from "../components/copy-selector";
import { ExtensionDashboard } from "../components/extensions";
import { HistorySearchComponent } from "../components/history-search";
import { LoginDialogComponent } from "../components/login-dialog";
import { LogoutAccountSelectorComponent } from "../components/logout-account-selector";
import { modalRevealEnabled } from "../components/modal-shell";
import { ModelHubComponent } from "../components/model-hub";
import { ModelPickerComponent } from "../components/model-picker";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { ResetUsageSelectorComponent } from "../components/reset-usage-selector";
import { SessionSelectorComponent } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { SubcommandPickerComponent } from "../components/subcommand-picker";
import { ThinkingSelectorComponent } from "../components/thinking-selector";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TranscriptBlock } from "../components/transcript-container";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";
import type { SessionObserverRegistry } from "../session-observer-registry";
import { buildCopyTargets } from "../utils/copy-targets";

/**
 * The slice of the interactive context this uses: 33 members of the 215
 * `InteractiveModeContext` requires. Still a slice, and naming it is what lets a
 * test construct one without the `as unknown as InteractiveModeContext` cast the
 * full interface forces (see `CollabHostContext`).
 */
export type SelectorControllerContext = Pick<
	InteractiveModeContext,
	| "applyCwdChange"
	| "chatContainer"
	| "clearTransientSessionUi"
	| "collabGuest"
	| "editor"
	| "editorContainer"
	| "effectiveHideThinkingBlock"
	| "focusAgentSession"
	| "handleDebugTranscriptCommand"
	| "handleUsageCommand"
	| "hideThinkingBlock"
	| "historyStorage"
	| "keybindings"
	| "mcpManager"
	| "oauthManualInput"
	| "planModeEnabled"
	| "present"
	| "proseOnlyThinking"
	| "rebuildChatFromMessages"
	| "refreshSlashCommandState"
	| "reloadTodos"
	| "renderInitialMessages"
	| "session"
	| "sessionManager"
	| "settings"
	| "showDebugSelector"
	| "showError"
	| "showHookConfirm"
	| "showHookEditor"
	| "showHookSelector"
	| "showStatus"
	| "showWarning"
	| "shutdown"
	| "statusContainer"
	| "statusLine"
	| "toolOutputExpanded"
	| "ui"
	| "updateEditorBorderColor"
>;

const MANUAL_LOGIN_TIP = "Tip: You can complete pairing with /login <redirect URL>.";

export class SelectorController {
	constructor(private ctx: SelectorControllerContext) {}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const oauthProviders = getOAuthProviders();
		await Promise.all(
			oauthProviders.map(provider =>
				// This refreshes the selector's view of which providers are authenticated. A provider whose key
				// cannot be resolved is exactly what "not authenticated" looks like here, and the registry
				// reports its own resolution failures; treating one as fatal would empty the whole selector.
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}

	/**
	 * Restore keyboard focus to whatever currently owns the editor slot. The
	 * slot can hold the editor itself or a hook selector/input/editor pushed
	 * in by `ExtensionUiController` — e.g. an approval prompt that fired while
	 * a fullscreen overlay was up. `overlayHandle.hide()` restores focus to
	 * the component focused when the overlay opened, which is stale in that
	 * case (the editor was swapped out): keys land on a hidden editor and the
	 * visible prompt receives nothing (issue #3349). Call this after the
	 * overlay hides to re-target focus at the visible slot owner.
	 */
	focusActiveEditorArea(): void {
		const visible = this.ctx.editorContainer.children[0] ?? this.ctx.editor;
		this.ctx.ui.setFocus(visible);
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		// Re-entrant guard: a selection path and a cancel path may both call
		// `done()` (or a component may fire both), so the editor is restored
		// exactly once instead of clearing and re-adding it twice.
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	/**
	 * Shows a floating ModalShell picker as a fullscreen overlay (clear underpaint).
	 * Prefer this over {@link showSelector} for structure-system pickers.
	 */
	showModalSelector(
		create: (done: () => void) => {
			component: Component & { setOnRequestRender?: (cb: () => void) => void };
			focus: Component;
		},
	): void {
		let overlayHandle: OverlayHandle | undefined;
		// Re-entrant guard + early-close handling. `done()` may fire more than
		// once (a select path and a cancel path can race), so the overlay must
		// hide exactly once. It may also fire synchronously inside `create()`,
		// before `showOverlay` has returned a handle to hide; in that case we
		// record the request and run the teardown right after the handle exists,
		// so the overlay never gets stranded open (Law 10: no silent no-op).
		let closed = false;
		let closeRequestedEarly = false;
		const done = () => {
			if (closed) return;
			if (!overlayHandle) {
				closeRequestedEarly = true;
				return;
			}
			closed = true;
			overlayHandle.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const { component, focus } = create(done);
		component.setOnRequestRender?.(() => this.ctx.ui.requestRender());
		overlayHandle = this.ctx.ui.showOverlay(component, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		if (closeRequestedEarly) {
			done();
			return;
		}
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	showSettingsSelector(initialItemId?: string): void {
		Promise.all([
			getAvailableThemes(),
			resolveAvailablePersonalities({ cwd: getProjectDir() }),
			// Asked BEFORE the panel is built: the rollback row is offered only on
			// an install that can actually perform one, and a source checkout
			// cannot. Showing it there would put a row in front of the operator
			// whose only outcome is a refusal.
			isRollbackSupported(),
		]).then(([availableThemes, availablePersonalities, rollbackSupported]) => {
			// Fullscreen settings editor on the alternate screen: the overlay
			// enables mouse tracking (click/hover/wheel) for its lifetime and
			// the transcript stays untouched underneath.
			let overlayHandle: OverlayHandle | undefined;
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
					thinkingLevel: this.ctx.session.thinkingLevel,
					availableThemes,
					availablePersonalities,
					providers: [...new Set(this.ctx.session.getAvailableModels().map(model => model.provider))].sort(
						(a, b) => a.localeCompare(b),
					),
					cwd: getProjectDir(),
					model: this.ctx.session.model,
					imageBudget: this.ctx.ui.imageBudget,
					requestRender: () => this.ctx.ui.requestRender(),
					modelRegistry: this.ctx.session.modelRegistry,
					availableModels: this.ctx.session.getAvailableModels(),
				},
				{
					onChange: (id, value) => this.handleSettingChange(id, value),
					onOpenUrl: url => openPath(url),
					// Supplying this is what makes the "Roll back version" row appear.
					// The install runs AFTER the overlay is torn down, because it
					// prints progress and can fail with a message worth reading, none
					// of which survives painting under a screen about to be restored.
					onRollback: rollbackSupported ? version => rollbackToVersion(version) : undefined,
					onError: message => this.ctx.showWarning(message),
					onThemePreview: async themeName => {
						const result = await previewTheme(themeName);
						if (result.success) {
							this.ctx.statusLine.invalidate();
							this.ctx.ui.invalidate();
							this.ctx.ui.requestRender();
						}
					},
					onStatusLinePreview: previewSettings => {
						// Update status line with preview settings
						this.ctx.statusLine.updateSettings({
							preset: settings.get("statusLine.preset"),
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							sessionAccent: settings.get("statusLine.sessionAccent"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
							...previewSettings,
						});
						this.ctx.ui.requestRender();
					},
					getStatusLinePreview: () => {
						// Preview the quiet composer zones (what the operator actually sees),
						// two rows: location above, capability below.
						const width = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
						const { locationLine, capabilityLine } = this.ctx.statusLine.renderQuietLines(width);
						return `${locationLine}\n${capabilityLine}`;
					},
					onPluginsChanged: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.ctx.refreshSlashCommandState();
						await this.ctx.session.refreshSshTool({ activateIfAvailable: true });
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						// Restore status line to saved settings
						this.ctx.statusLine.updateSettings({
							preset: settings.get("statusLine.preset"),
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							sessionAccent: settings.get("statusLine.sessionAccent"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
						});
						this.ctx.ui.requestRender();
					},
				},
				initialItemId,
				modalRevealEnabled(),
			);
			overlayHandle = this.ctx.ui.showOverlay(selector, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(selector);
			this.ctx.ui.requestRender();
		});
	}

	showAdvisorConfigure(): void {
		this.ctx.showStatus("Advisor/watchdog was removed from Veyyon.");
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showModalSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				modalRevealEnabled(),
			);
			return { component, focus: component };
		});
	}

	/**
	 * Thinking-effort picker for the interactive session.
	 *
	 * The control follows the active model's valid variant list, including
	 * narrower families such as low/high-only models.
	 */
	showThinkingSelector(): void {
		const model = this.ctx.session.model;
		if (!hasConfigurableThinkingEffort(model)) {
			this.ctx.showStatus("This model does not expose configurable reasoning effort.");
			return;
		}
		const currentLevel = this.ctx.session.sessionThinkingOverride;
		this.showModalSelector(done => {
			const component = new ThinkingSelectorComponent(
				currentLevel,
				model,
				level => {
					this.ctx.session.setThinkingLevel(level);
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorBorderColor();
					done();
				},
				() => done(),
				modalRevealEnabled(),
			);
			return { component, focus: component };
		});
	}

	/**
	 * The subcommand picker a bare `/cmd` opens.
	 *
	 * `done()` runs BEFORE `onSelect`, so the card is gone by the time the chosen subcommand runs.
	 * A subcommand may open a screen of its own (`/account manager`) or prefill the editor, and
	 * both would be drawn underneath a picker that was still up.
	 */
	showSubcommandPicker(
		commandName: string,
		subcommands: readonly SubcommandDef[],
		onSelect: (subcommand: SubcommandDef) => void,
	): void {
		this.showModalSelector(done => {
			const component = new SubcommandPickerComponent(
				commandName,
				subcommands,
				subcommand => {
					done();
					onSelect(subcommand);
				},
				() => done(),
				modalRevealEnabled(),
			);
			return { component, focus: component };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(
			getProjectDir(),
			this.ctx.settings,
			this.ctx.ui.terminal.rows,
			modalRevealEnabled(),
		);
		// Fullscreen dashboard on the alternate screen (the /settings idiom): the
		// overlay borrows the terminal's alt buffer and enables mouse tracking for
		// its lifetime, leaving the transcript untouched underneath.
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	/**
	 * Show the Agent Control Center: the ONE agent surface.
	 *
	 * Every entry point lands here — `/agents`, `/cockpit` (alias `/hub`), the
	 * `app.agents.hub` and `app.session.observe` keys, and the editor's `←←`
	 * gesture — because they were three separate rosters that could disagree
	 * about what was running.
	 *
	 * `requireContent` is the gesture's gate: `←←` on an empty editor must stay
	 * inert until there is a subagent to look at, while an explicit key still
	 * opens the empty roster. Agents persisted by earlier runs register
	 * asynchronously, so the gate waits for that scan rather than treating the
	 * initial roster as the answer.
	 */
	showAgentsDashboard(observers: SessionObserverRegistry, options?: { requireContent?: boolean }): void {
		const dashboard = new AgentDashboard({
			terminalHeight: this.ctx.ui.terminal.rows,
			reveal: modalRevealEnabled(),
			// The comms stream expands a folded message with the same key the
			// transcript expands a truncated tool result with.
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			hubKeys: [
				...this.ctx.keybindings.getKeys("app.agents.hub"),
				...this.ctx.keybindings.getKeys("app.session.observe"),
			],
			registry: this.ctx.collabGuest?.agentRegistry,
			remote: this.ctx.collabGuest?.agentRemote,
			observers,
			showModelBadge: settings.get("subagent.showResolvedModelBadge"),
			sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
			// The roster is this conversation's, not the process's. Without it a
			// session resumed with `/resume` listed the subagents of every
			// conversation the process had driven before it.
			scope: this.ctx.sessionManager.getSessionId(),
			focusAgent: id => this.ctx.focusAgentSession(id),
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
		});
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};

		const show = () => {
			// Fullscreen dashboard on the alternate screen (the /settings idiom): the
			// overlay borrows the terminal's alt buffer and enables mouse tracking for
			// its lifetime, leaving the transcript untouched underneath. The card
			// itself floats within this via ModalShell LARGE (see agent-dashboard.ts).
			const overlay = this.ctx.ui.showOverlay(dashboard, {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0,
				fullscreen: true,
			});
			dashboard.onClose = () => {
				// The card subscribes to the process-global registry and bus; without
				// this it would keep rebuilding a layout nobody is looking at, once per
				// agent event and once per message, for the rest of the session.
				dashboard.dispose();
				overlay.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			this.ctx.ui.requestRender();
		};

		if (options?.requireContent && dashboard.isEmpty) {
			void dashboard.persistedSubagentsReady.then(() => {
				if (dashboard.isEmpty) {
					dashboard.dispose();
					return;
				}
				show();
			});
			return;
		}
		show();
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	handleSettingChange(id: string, value: unknown): void | Promise<void> {
		// Discovery provider toggles
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		// Auth storage and the model registry capture the profile-sharing backing
		// store at startup. Persisting a different posture without replacing both
		// atomically would leave the UI claiming one policy while dispatch still
		// reads the old store. Begin teardown synchronously (shutdown marks the
		// context as shutting down before its first await), making restart the
		// explicit dispatch barrier.
		if (id === "profileSharing") {
			this.ctx.showWarning(
				"Credential sharing changed. Restart required; this session is shutting down before further model dispatch.",
			);
			return this.ctx.shutdown().catch(err => {
				this.ctx.showError(`Failed to shut down after changing credential sharing: ${errorMessage(err)}`);
			});
		}

		// Any setting the prompt gates on rebuilds the prompt, read off the ONE registry that
		// records which those are (`system-prompt-builder/gate-registry.ts`). This used to be a
		// `case` per setting and carried two of the nine: flipping `subagent.batch`,
		// `subagent.delegation`, `subagent.maxConcurrency`, `subagent.agents`,
		// `includeModelInPrompt` or `tools.format` changed the setting and
		// left the prompt describing the previous configuration, with nothing logged. The
		// switch below still runs, for the UI side effects a flip also needs.
		if (isLivePromptGate(id)) {
			this.ctx.session.refreshBaseSystemPrompt(`setting:${id}`).catch(err => {
				this.ctx.showError(`Failed to apply "${id}" to the system prompt: ${errorMessage(err)}`);
			});
		} else {
			// A prompt gate this session captured at startup cannot follow the flip. Saying so is
			// the point: the settings UI shows the new value either way, so without this the
			// operator has no way to tell an applied change from one that did nothing.
			const frozen = frozenGateNotice(id);
			if (frozen !== undefined) this.ctx.showWarning(frozen);
		}

		// Secret settings own live process state, not only persisted configuration.
		// Return the coordinator-backed transition rather than dropping its
		// promise. Rapid toggles then retain initiation order and callers that can
		// await the setting side effect observe the committed runtime.
		if (id.startsWith("secrets.")) {
			return this.ctx.session.refreshSecrets().catch(err => {
				this.ctx.showError(`Failed to apply "${id}" to the secret runtime: ${errorMessage(err)}`);
			});
		}

		switch (id) {
			// Session-managed settings (not in SettingsManager)
			case "autoCompact":
				this.ctx.session.setAutoCompactionEnabled(value as boolean);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "session.instrumentation":
				this.ctx.session.setInstrumentationLevel(value as InstrumentationLevel);
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ConfiguredThinkingLevel);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;
			// `personality` needs no arm of its own: it is a registered prompt gate, and the
			// rebuild above covers it. Kept out of the switch rather than left as an empty case
			// so there is nothing to read that looks like it still does the work.

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;

			// Settings with UI side effects
			case "showImages":
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(value as boolean);
					}
				}
				break;
			case "hideThinkingBlock":
				this.ctx.hideThinkingBlock = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
					}
				}
				// Full clear + replay so blocks frozen in committed scrollback on
				// ED3-risk terminals retire their stale snapshots too (see
				// InputController.toggleThinkingBlockVisibility).
				this.ctx.ui.resetDisplay();
				break;
			case "proseOnlyThinking":
				this.ctx.proseOnlyThinking = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setProseOnlyThinking(value as boolean);
					}
				}
				this.ctx.ui.resetDisplay();
				break;
			case "omitThinking":
				this.ctx.session.agent.hideThinkingSummary = value as boolean;
				break;
			case "display.cacheMissMarker":
				// Rebuild re-runs the usage-based detection under the new setting so
				// markers appear/disappear; full reset retires any already committed
				// to native scrollback (mirrors hideThinking).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.collapseCompacted":
				// Rebuild swaps between the collapsed tail and the full inline
				// history; full reset retires blocks already committed to native
				// scrollback (mirrors cacheMissMarker).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "tui.tight":
				setTuiTight(value as boolean);
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;

			case "tui.scrollbackRebuild":
				this.ctx.ui.setScrollbackRebuild(value as boolean);
				break;

			case "tui.scrollIsolation":
				this.ctx.ui.setScrollIsolation(value as boolean);
				break;

			case "tui.renderMermaid":
				// The prompt rebuild is the registry's, above. What is left here is the part that
				// is genuinely about the TUI: the renderer switch and retiring committed blocks.
				setMarkdownMermaidRendering(value as boolean);
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;

			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
					this.#surfaceThemeResult(result, `load theme "${value}"`);
				});
				break;
			}
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
					this.#surfaceThemeResult(result, "apply symbol preset");
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(result => {
					this.ctx.ui.invalidate();
					this.#surfaceThemeResult(result, "apply color-blind mode");
				});
				break;
			}
			// Every sampling knob applies the same way: read "is this unset" through
			// the ONE owner and hand the rest to the agent. Each of these used to be
			// its own case testing `value >= 0`, which discarded every NEGATIVE value
			// along with the sentinel — and `presencePenalty` and `repetitionPenalty`
			// accept negatives, so configuring one did nothing. The same test was
			// also written out in sdk.ts, where the bug had to be fixed twice.
			case "temperature":
			case "topP":
			case "topK":
			case "minP":
			case "presencePenalty":
			case "repetitionPenalty": {
				applySamplingKnob(this.ctx.session.agent, id, optionalNumber(toNumberOrUndefined(value)));
				break;
			}
			case "git.enabled":
			// The composer reads `statusLine.enabled` on each render, so applying it is a
			// render request; it is here so the row appears or disappears under the open
			// settings screen rather than on the next unrelated frame.
			case "statusLine.enabled":
			case "statusLinePreset":
			case "statusLine.preset":
			case "statusLineSeparator":
			case "statusLine.separator":
			case "statusLineShowHooks":
			case "statusLine.showHookStatus":
			case "statusLine.sessionAccent":
			case "statusLine.transparent":
			case "statusLine.compactThinkingLevel":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				const statusLineSettings = {
					preset: settings.get("statusLine.preset"),
					leftSegments: settings.get("statusLine.leftSegments"),
					rightSegments: settings.get("statusLine.rightSegments"),
					separator: settings.get("statusLine.separator"),
					showHookStatus: settings.get("statusLine.showHookStatus"),
					sessionAccent: settings.get("statusLine.sessionAccent"),
					transparent: settings.get("statusLine.transparent"),
					segmentOptions: settings.get("statusLine.segmentOptions"),
					compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.ui.requestRender();
				break;
			}

			// Provider settings - update runtime preferences
			case "providers.webSearch":
				if (typeof value === "string" && isSearchProviderPreference(value)) {
					setPreferredSearchProvider(value);
				}
				break;
			case "providers.webSearchExclude":
				if (Array.isArray(value)) {
					setExcludedSearchProviders(value.filter(isSearchProviderId));
				}
				break;
			case "providers.image":
				if (isImageProviderPreference(value)) {
					setPreferredImageProvider(value);
				}
				break;

			// MCP update injection - live subscribe/unsubscribe
			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#showModelPicker(options?.temporaryOnly === true);
	}

	/**
	 * Report a theme reload that did not do what was asked. `fellBack` means the
	 * user is now looking at a theme they did not pick, so it always gets said
	 * out loud; anything else failed without changing what is on screen.
	 */
	#surfaceThemeResult(result: ThemeLoadResult, attempted: string): void {
		if (result.success) return;
		const detail = result.error ? `: ${result.error}` : "";
		this.ctx.showError(
			result.fellBack
				? `Failed to ${attempted}${detail}\nFell back to the ${FALLBACK_THEME_NAME} theme.`
				: `Failed to ${attempted}${detail}`,
		);
	}

	/**
	 * Compact session model picker (alt+p / `/switch` / `/model`): a floating
	 * bottom-anchored overlay over the transcript.
	 */
	#showModelPicker(temporaryOnly: boolean): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const current = this.ctx.session.model;
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const picker = new ModelPickerComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onPick: async (model, selector) => {
					try {
						const roleThinkingLevel = this.ctx.session.resolveTemporaryModelThinkingLevel(model);
						if (temporaryOnly) {
							await this.ctx.session.setModelTemporary(model, roleThinkingLevel);
							this.ctx.showStatus(`Session-only model: ${selector}`);
						} else {
							await this.ctx.session.setModel(model, DEFAULT_MODEL_SLOT, {
								selector,
								thinkingLevel: roleThinkingLevel,
								persist: true,
								currentContextTokens,
							});
							this.ctx.showStatus(`Model: ${selector}`);
						}
						this.ctx.statusLine.invalidate();
						this.ctx.updateEditorBorderColor();
						done();
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					}
				},
				onCancel: done,
			},
			{
				currentContextTokens,
				currentSelector: current ? `${current.provider}/${current.id}` : undefined,
				reveal: modalRevealEnabled(),
			},
		);
		// Fullscreen host; ModelPicker paints a floating ModalShell medium card.
		overlayHandle = this.ctx.ui.showOverlay(picker, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(picker);
		this.ctx.ui.requestRender();
	}

	/**
	 * Fullscreen model hub on the alternate screen (the /settings idiom): the
	 * overlay enables mouse tracking for its lifetime and the transcript stays
	 * untouched underneath. `initialProviderId` preselects a provider's sidebar
	 * entry — used when reopening the hub after a /login round-trip.
	 */
	#showModelHub(hubOptions: { initialProviderId?: string }): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		let overlayHandle: OverlayHandle | undefined;
		let hub: ModelHubComponent | undefined;
		let closed = false;
		const done = () => {
			// Re-entrant guard: cancel paths (Esc, login forward) may race;
			// the overlay must hide exactly once.
			if (closed) return;
			closed = true;
			hub?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		hub = new ModelHubComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onAssign: async (model, role, thinkingLevel, selector) => {
					const selectedThinking =
						thinkingLevel === undefined || thinkingLevel === ThinkingLevel.Inherit ? undefined : thinkingLevel;
					const selectorValue = selector ?? `${model.provider}/${model.id}`;
					try {
						if (isDefaultModelSlot(role)) {
							const { switched } = await this.ctx.session.setModel(model, DEFAULT_MODEL_SLOT, {
								selector,
								thinkingLevel: selectedThinking,
								persist: true,
								currentContextTokens,
							});
							if (switched) {
								this.ctx.statusLine.invalidate();
								this.ctx.updateEditorBorderColor();
							}
							this.ctx.showStatus(`Model: ${selector ?? model.id}`);
						} else {
							this.ctx.settings.setModelRole(role, formatModelSelectorValue(selectorValue, selectedThinking));
							const roleInfo = getRoleInfo(role, settings);
							this.ctx.showStatus(`${roleInfo?.name ?? role} model: ${selector ?? model.id}`);
						}
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					}
				},
				onUnassign: role => {
					try {
						this.ctx.settings.setModelRole(role, undefined);
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(`${roleInfo?.name ?? role} role cleared — auto-selection applies`);
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					}
				},
				onFallbackChainChange: (role, chain) => {
					try {
						const chains = { ...this.ctx.settings.get("retry.fallbackChains") };
						if (chain.length === 0) {
							delete chains[role];
						} else {
							chains[role] = chain;
						}
						this.ctx.settings.set("retry.fallbackChains", chains);
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(
							chain.length > 0
								? `${roleInfo?.name ?? role} fallbacks: ${chain.join(" → ")}`
								: `${roleInfo?.name ?? role} fallbacks cleared`,
						);
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					}
				},

				onLoginRequest: providerId => {
					done();
					void this.#loginThenReopenModelHub(providerId);
				},
				onCycleOrderChange: order => {
					try {
						this.ctx.settings.set("cycleOrder", order);
						this.ctx.showStatus(
							order.length > 0 ? `Quick-switch cycle: ${order.join(" → ")}` : "Quick-switch cycle cleared",
						);
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					}
				},
				onCancel: () => done(),
			},
			{
				initialProviderId: hubOptions.initialProviderId,
				reveal: modalRevealEnabled(),
			},
		);
		overlayHandle = this.ctx.ui.showOverlay(hub, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(hub);
		this.ctx.ui.requestRender();
	}

	/** /login round-trip for a locked provider; reopen the hub on that provider only after a successful login. */
	async #loginThenReopenModelHub(providerId: string): Promise<void> {
		const succeeded = await this.#handleOAuthLogin(providerId);
		if (succeeded) {
			this.#showModelHub({ initialProviderId: providerId });
		}
	}

	async showPluginSelector(_mode: "install" | "uninstall" = "install"): Promise<void> {
		this.ctx.showStatus("Marketplace plugins were removed. Use `veyyon plugin install` for npm/git/local plugins.");
	}

	showUserMessageSelector(): void {
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		this.showModalSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ctx.ui.requestRender();
						return;
					}

					this.ctx.renderInitialMessages({ clearTerminalHistory: true });
					this.ctx.editor.setText(result.selectedText);
					done();
					this.ctx.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				modalRevealEnabled(),
			);
			return { component: selector, focus: selector };
		});
	}

	showCopySelector(): void {
		const targets = buildCopyTargets(this.ctx.session);
		if (targets.length === 0) {
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}

		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.ctx.ui.requestRender();
		};
		const selector = new CopySelectorComponent(
			targets,
			{
				onPick: target => {
					done();
					if (target.content === undefined) return;
					void copyToClipboard(target.content);
					this.ctx.showStatus(target.copyMessage ?? "Copied to clipboard");
				},
				onCancel: done,
			},
			modalRevealEnabled(),
		);

		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		selector.setOnRequestRender?.(() => this.ctx.ui.requestRender());
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async entryId => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.ctx.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						const result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						// Update UI — rebuild the display transcript for the new leaf (the
						// context from navigateTree is the LLM context, not the transcript).
						this.ctx.renderInitialMessages({ clearTerminalHistory: true });
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setText(result.editorText);
						}
						this.ctx.showStatus("Navigated to selected point");
					} catch (error) {
						this.ctx.showError(errorMessage(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.disposeChildren();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	async showSessionSelector(): Promise<void> {
		const sessions = await SessionManager.list(
			this.ctx.sessionManager.getCwd(),
			this.ctx.sessionManager.getSessionDir(),
		);
		// Always open in current-folder scope; the empty-state hint in SessionList
		// invites the user to Tab into all-projects rather than silently surfacing
		// every project's history when the cwd has nothing to resume. See #3099.
		const historyStorage = this.ctx.historyStorage;
		const historyMatcher = historyStorage ? (query: string) => historyStorage.matchingSessionIds(query) : undefined;
		// Fullscreen session picker on the alternate screen (the /settings idiom):
		// the overlay borrows the alt buffer and enables mouse tracking (wheel
		// scroll + click-to-resume) for its lifetime, leaving the transcript
		// untouched underneath. Anchored top-left at full size so a mouse row maps
		// directly to a rendered line (the overlay paints from screen row 0), and
		// `fillHeight` selects the large centered-card sizing (card height
		// itself tracks the session list, so a short list stays a short card).
		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new SessionSelectorComponent(
			sessions,
			async (session: SessionInfo) => {
				done();
				await this.handleResumeSession(session.path);
			},
			() => {
				done();
			},
			() => {
				// Release the alt buffer before teardown: shutdown() awaits flush/save/
				// dispose/drain before stop() leaves the alt screen, so without this the
				// fullscreen picker would freeze on screen for that window on Ctrl+C.
				done();
				void this.ctx.shutdown();
			},
			{
				onDelete: async (session: SessionInfo) => {
					if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
						return false;
					}
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(session.path);
						return true;
					} catch (err) {
						throw new Error(`Failed to delete session: ${errorMessage(err)}`, {
							cause: err,
						});
					}
				},
				historyMatcher,
				loadAllSessions: () => SessionManager.listAll(),
				getTerminalRows: () => this.ctx.ui.terminal.rows,
				fillHeight: true,
				reveal: modalRevealEnabled(),
			},
		);
		selector.setOnRequestRender(() => this.ctx.ui.requestRender());
		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.ctx.clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.ui.requestRender();
		this.ctx.updateEditorBorderColor();
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		this.ctx.clearTransientSessionUi();

		const previousCwd = this.ctx.sessionManager.getCwd();
		// Switch session via AgentSession (emits hook and tool session events). The
		// SessionManager adopts the resumed session's own cwd when it differs.
		await this.ctx.session.switchSession(sessionPath);
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		if (movedProject) {
			// Resumed a session from another project: re-point the process and every
			// cwd-derived cache at it before rendering.
			await this.ctx.applyCwdChange(newCwd);
		}
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.showStatus(movedProject ? `Resumed session in ${shortenPath(newCwd)}` : "Resumed session");
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}

	/**
	 * Run the OAuth login flow for `providerId` inside a cancellable
	 * {@link LoginDialogComponent} that replaces the editor slot. Esc aborts:
	 * the dialog's abort signal reaches the provider flow, any pending prompt
	 * rejects, and the editor is restored immediately. Returns true when
	 * credentials were stored.
	 */
	async #handleOAuthLogin(providerId: string): Promise<boolean> {
		// `formatProviderName`, not the raw slug: the account card, the model hub and the footline all
		// name this provider the same way, and a login is where the operator meets it first.
		const providerLabel = formatProviderName(providerId);
		this.ctx.showStatus(`Logging in to ${providerLabel}…`);
		const manualInput = this.ctx.oauthManualInput;
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		let restored = false;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		const dialog = new LoginDialogComponent(this.ctx.ui, providerId, (_success, message) => {
			// Fires on Esc: unblock the editor immediately; the aborted flow's
			// rejection settles the awaited login below.
			restoreEditor();
			if (message) this.ctx.showStatus(message);
		});
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(dialog);
		this.ctx.ui.setFocus(dialog);
		this.ctx.ui.requestRender();
		try {
			const identity = await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					// The dialog renders the full URL (SSH-safe copy target) and
					// opens the browser best-effort.
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
					if (useManualInput) {
						dialog.showProgress(MANUAL_LOGIN_TIP);
					}
				},
				// The whole prompt, not two of its fields: the flow that asks declares whether the answer
				// is a credential (`secret`), and the dialog masks the input from that rather than
				// guessing from the message text.
				onPrompt: (prompt: { message: string; placeholder?: string; secret?: boolean }) =>
					dialog.showPrompt(prompt),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},
				onManualCodeInput: useManualInput ? () => manualInput.waitForInput(providerId) : undefined,
				onSuccessPage: (url: string) => {
					// Device-code/paste flows (grok, Copilot, Kimi) get no browser
					// redirect of their own; open the freshly-served branded success
					// page so every provider ends on the same "Signed in" screen.
					openPath(url);
				},
			});
			this.ctx.session.modelRegistry.refreshInBackground();
			// Naming happens here, while the operator still knows which account this was. Doing it from
			// the account card instead asks them to recognize it later, among the others, which is the
			// moment the name would have helped.
			const accountName = await this.#offerAccountName(dialog, providerId, providerLabel, identity?.credentialId);
			const block = new TranscriptBlock();
			// Name the account (and Anthropic organization) that was stored so a
			// login that lands on an unintended account/subscription is visible
			// immediately instead of silently replacing an existing registration.
			const whoBase = identity?.type === "oauth" ? (identity.email ?? identity.accountId) : undefined;
			const whoOrg = identity?.type === "oauth" ? (identity.orgName ?? identity.orgId) : undefined;
			const who = whoBase ? ` as ${whoBase}${whoOrg ? ` (${whoOrg})` : ""}` : whoOrg ? ` as ${whoOrg}` : "";
			block.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Successfully logged in to ${providerLabel}${who}`),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credentials saved to ${getActiveAuthDbPath()}`), 1, 0));
			if (accountName) {
				const named = `Named "${accountName}". Change it any time with /account`;
				block.addChild(new Text(theme.fg("dim", named), 1, 0));
			}
			this.ctx.present(block);
			return true;
		} catch (error: unknown) {
			if (dialog.signal.aborted) {
				// User-cancelled: the dialog already restored the editor and
				// surfaced "Login cancelled".
				return false;
			}
			this.ctx.showError(`Login failed: ${errorMessage(error)}`);
			return false;
		} finally {
			if (useManualInput) {
				manualInput.clear(`Manual OAuth input cleared for ${providerId}`);
			}
			restoreEditor();
		}
	}

	/**
	 * Offer to name the account a login just stored, and return the name that was kept.
	 *
	 * Asked only from the SECOND account for a provider onwards. A lone Anthropic credential is
	 * unambiguous everywhere it appears, so asking for a nickname there is a step that buys nothing;
	 * the moment a second one lands, every list that shows them needs a way to tell them apart, and
	 * the operator knows which is which exactly now. Esc skips, and skipping is not a failure: the
	 * credential is already stored.
	 */
	async #offerAccountName(
		dialog: LoginDialogComponent,
		providerId: string,
		providerLabel: string,
		credentialId: number | undefined,
	): Promise<string | undefined> {
		// No row id means the store could not say which row it wrote, and naming the wrong sibling is
		// worse than not asking.
		if (credentialId === undefined) return undefined;
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		if (authStorage.listStoredCredentials(providerId).length < 2) return undefined;
		const name = await dialog.askOptionalName(`Name this ${providerLabel} account (optional)`, "work");
		if (!name) return undefined;
		if (!authStorage.setAccountName(providerId, credentialId, name)) {
			this.ctx.showWarning(
				`Could not name that account: ${providerLabel} credentials are stored where names cannot be kept`,
			);
			return undefined;
		}
		return name;
	}

	async #handleCredentialLogout(providerId: string, account: LogoutAccount): Promise<void> {
		const providerLabel = formatProviderName(providerId);
		try {
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.removeCredential(providerId, account.credentialId);
			if (!removed) {
				this.ctx.showError(`Logout skipped: ${account.label} is no longer stored for ${providerLabel}.`);
				return;
			}

			await this.ctx.session.modelRegistry.refresh();
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg(
						"success",
						`${theme.status.success} Successfully logged out ${account.label} from ${providerLabel}`,
					),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credential removed from ${getActiveAuthDbPath()}`), 1, 0));
			const remainingSource = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			if (remainingSource) {
				block.addChild(
					new Text(theme.fg("warning", `${providerLabel} is still authenticated via ${remainingSource}`), 1, 0),
				);
			}
			this.ctx.present(block);
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${errorMessage(error)}`);
		}
	}

	async #showOAuthLogoutAccountSelector(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.reload();
		} catch (error: unknown) {
			this.ctx.showError(`Could not load stored credentials: ${errorMessage(error)}`);
			return;
		}
		const accounts = toLogoutAccounts(providerId, authStorage.listStoredCredentials(providerId), {
			activeIdentity: authStorage.getOAuthAccountIdentity(providerId, this.ctx.session.sessionId),
			activeApiKey: authStorage.getCredentialOrigin(providerId)?.kind === "api_key",
		});
		if (accounts.length === 0) {
			const source = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
			this.ctx.showError(`Logout skipped: no stored credentials for ${formatProviderName(providerId)}.${suffix}`);
			return;
		}

		this.showModalSelector(done => {
			const selector = new LogoutAccountSelectorComponent(
				// One label owner. `getOAuthProviders()` has no row for a provider that authenticates with
				// an api key, and this selector now opens for those too, so reading its name from there
				// printed the raw slug (`Logout · groq`) while every other surface said `Groq`.
				formatProviderName(providerId),
				accounts,
				account => {
					done();
					void this.#handleCredentialLogout(providerId, account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},

				modalRevealEnabled(),
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * The login/logout surface every spelling of the command reaches (`/login`, `/account login`,
	 * `/logout`, `/account logout`); the account card and the model hub have their own wrappers.
	 *
	 * A login that STORES a credential ends in the account manager, focused on the provider it just
	 * added. `/login` is documented as an alias of `/account login`, and it was not one in the place
	 * it mattered: the card's own "add another account" came back to the card, while the same login
	 * typed at the composer dropped the operator back at an empty prompt with one receipt line and no
	 * way to see which account now serves. A cancelled or failed login stays where it was, because
	 * the composer is where that operator came from and there is nothing new to show them.
	 */
	async showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		if (providerId) {
			if (mode === "login") {
				if (await this.#handleOAuthLogin(providerId)) await this.showAccountManager(providerId);
			} else {
				await this.#showOAuthLogoutAccountSelector(providerId);
			}
			return;
		}

		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.has(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No stored provider credentials to log out. Remove env or config auth at its source.");
				return;
			}
		}

		this.showModalSelector(done => {
			let selector: OAuthSelectorComponent;
			selector = new OAuthSelectorComponent(
				mode,
				this.ctx.session.modelRegistry.authStorage,
				async (selectedProviderId: string) => {
					selector.stopValidation();
					done();
					if (mode === "login") {
						if (await this.#handleOAuthLogin(selectedProviderId)) {
							await this.showAccountManager(selectedProviderId);
						}
					} else {
						await this.#showOAuthLogoutAccountSelector(selectedProviderId);
					}
				},
				() => {
					selector.stopValidation();
					done();
					this.ctx.ui.requestRender();
				},
				{
					validateAuth: async (selectedProviderId: string) => {
						const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
							selectedProviderId,
							this.ctx.session.sessionId,
						);
						return !!apiKey;
					},
					// Component-scoped: the validating spinner ticks every 80ms while
					// this selector is shown over a possibly large live transcript;
					// a full requestRender() would re-walk that whole tree per tick
					// purely to advance a spinner glyph or one provider's auth state.
					requestRender: () => {
						this.ctx.ui.requestComponentRender(selector);
					},
					standalone: true,
					reveal: modalRevealEnabled(),
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * Fullscreen account manager: one row per stored CREDENTIAL, grouped by provider.
	 *
	 * Paints from the synchronous inventory first, then folds in health and usage as their probes
	 * land. That order is deliberate: probing every credential costs a network round-trip each, and
	 * a card that waits for them shows an empty frame for seconds on a multi-account setup. The
	 * component keeps its selection across `setInventory`, so the rows filling in underneath the
	 * cursor never move it.
	 */
	async showAccountManager(providerId?: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		const sessionId = this.ctx.session.sessionId;
		let overlayHandle: OverlayHandle | undefined;
		let manager: AccountManagerComponent | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			manager?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		// Re-read from the store rather than mutating the rendered model: a pin, a rename and a
		// logout all change what the store says, and rebuilding is the only way the card cannot
		// disagree with it.
		const reload = () => {
			if (closed) return;
			manager?.setInventory(buildAccountInventory(authStorage, { sessionId }));
			this.ctx.ui.requestRender();
		};

		manager = new AccountManagerComponent(
			await loadAccountInventory(authStorage, { sessionId }),
			{
				onUseAccount: row => {
					if (authStorage.selectProviderCredential(row.provider, row.credentialId, { sessionId })) {
						this.ctx.showStatus(
							`${row.providerLabel}: now using ${accountDisplayLabel(row)} everywhere on this machine`,
						);
					} else {
						// The credential vanished between render and keypress (a peer logged it out).
						// Say so; a silent no-op reads as the key being broken.
						this.ctx.showWarning(`${row.providerLabel}: that account is no longer stored`);
					}
					reload();
				},
				onRename: (row, name) => {
					const previous = accountDisplayLabel(row);
					if (!authStorage.setAccountName(row.provider, row.credentialId, name)) {
						this.ctx.showWarning(
							`Could not name that account — ${row.providerLabel} credentials are stored where names cannot be kept`,
						);
						return;
					}
					reload();
					this.ctx.showStatus(
						name.trim().length === 0
							? `${row.providerLabel}: cleared the name on ${previous}`
							: `${row.providerLabel}: ${previous} is now "${name.trim()}"`,
					);
				},
				onRefresh: () => {
					void this.#probeAccountHealth(
						() => manager,
						() => closed,
					);
				},
				onLogout: row => {
					void (async () => {
						try {
							const removed = await authStorage.removeCredential(row.provider, row.credentialId);
							if (!removed) {
								this.ctx.showWarning(`${row.providerLabel}: that account was already removed`);
							} else {
								this.ctx.showStatus(`${row.providerLabel}: logged out of ${accountDisplayLabel(row)}`);
							}
							await this.ctx.session.modelRegistry.refresh();
						} catch (error) {
							this.ctx.showError(`Logout failed: ${errorMessage(error)}`);
						}
						reload();
					})();
				},
				onShowUsage: () => {
					done();
					void this.ctx.handleUsageCommand();
				},
				onAddAccount: provider => {
					done();
					void this.#loginThenReopenAccountManager(provider);
				},
				onToggleLoadBalancing: () => {
					const next = !this.ctx.session.settings.get("accounts.loadBalancing");
					this.ctx.session.settings.set("accounts.loadBalancing", next);
					// Read back rather than trusting `next`: the card paints from what the settings
					// object actually holds, so a refused or coerced write cannot leave the footer
					// advertising a state the config does not have.
					const stored = this.ctx.session.settings.get("accounts.loadBalancing") === true;
					// A settings write is permanent, and a repainted two-word chip is a thin receipt
					// for one. Say what changed, what it now does, and that it outlives the session,
					// from the value that was actually stored.
					this.ctx.showStatus(
						stored
							? "Account load balancing on: an exhausted account moves to another account of the same provider. Saved for this profile."
							: "Account load balancing off: an exhausted account waits for its own quota window. Saved for this profile.",
						{ dim: false },
					);
					return stored;
				},
				onCancel: done,
			},
			{
				initialProviderId: providerId,
				loadBalancing: this.ctx.session.settings.get("accounts.loadBalancing") === true,
				reveal: modalRevealEnabled(),
				requestRender: () => {
					const component = manager;
					if (component) this.ctx.ui.requestComponentRender(component);
				},
			},
		);

		overlayHandle = this.ctx.ui.showOverlay(manager, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(manager);
		this.ctx.ui.requestRender();

		await this.#probeAccountHealth(
			() => manager,
			() => closed,
		);
	}

	/**
	 * `a` / `+ add another …` from the account card: log in, then come back to the card on the
	 * provider the login was started from.
	 *
	 * Reopened after a CANCELLED login too, not just a successful one, because escape unwinds one
	 * level: the login is what the user opened from the card, so abandoning it must return them to
	 * the card rather than to the composer. Reopening rebuilds the inventory from the store, which
	 * is what makes a freshly added account visible in the row list the user is already looking at
	 * instead of only on the next `/account`.
	 *
	 * The new credential is deliberately NOT made the serving account. With load balancing off, the
	 * selected credential decides what gets spent, and a login is not a request to move the
	 * session's traffic; the card shows the new row and `enter` moves traffic when the user says so.
	 */
	async #loginThenReopenAccountManager(providerId: string): Promise<void> {
		await this.#handleOAuthLogin(providerId);
		await this.showAccountManager(providerId);
	}

	/**
	 * Fold live health and usage into an open account manager.
	 *
	 * Both probes are best-effort and independent: a provider with no usage endpoint must not stop
	 * the health column from arriving, and a health probe that times out must not blank the usage
	 * bars. A failure leaves the affected column absent, which the card renders as "not probed"
	 * rather than as a healthy account.
	 */
	async #probeAccountHealth(
		getManager: () => AccountManagerComponent | undefined,
		isClosed: () => boolean,
	): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		const sessionId = this.ctx.session.sessionId;
		const baseUrlResolver = (target: string) => this.ctx.session.modelRegistry.getProviderBaseUrl?.(target);
		const [health, usage] = await Promise.all([
			authStorage.checkCredentials({ baseUrlResolver }).catch(error => {
				logger.debug("account manager: credential health probe failed", { error: errorMessage(error) });
				return [];
			}),
			this.ctx.session.fetchUsageReports().catch(error => {
				logger.debug("account manager: usage probe failed", { error: errorMessage(error) });
				return null;
			}),
		]);
		if (isClosed()) return;
		const manager = getManager();
		if (!manager) return;
		let inventory = applyCredentialHealth(await loadAccountInventory(authStorage, { sessionId }), health);
		if (usage) inventory = applyUsageReports(inventory, usage);
		manager.setInventory(inventory);
		this.ctx.ui.requestRender();
	}

	async showResetUsageSelector(): Promise<void> {
		const session = this.ctx.session;
		this.ctx.showStatus("Checking saved rate-limit resets…", { dim: true });
		let statuses: ResetCreditAccountStatus[];
		try {
			statuses = await session.listResetCredits();
		} catch (error) {
			this.ctx.showError(`Could not load saved resets: ${errorMessage(error)}`);
			return;
		}
		const accounts = toResetUsageAccounts(statuses);
		if (accounts.length === 0) {
			this.ctx.showStatus("No Codex accounts found. Use /login to add one.");
			return;
		}
		if (!accounts.some(account => account.availableCount > 0)) {
			this.ctx.showStatus(
				accounts.some(account => account.error)
					? "No saved resets available — some accounts couldn't be reached (try /login)."
					: "No saved rate-limit resets available to spend right now.",
			);
			return;
		}
		this.showModalSelector(done => {
			const selector = new ResetUsageSelectorComponent(
				accounts,
				account => {
					done();
					void this.#redeemReset(account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				modalRevealEnabled(),
			);
			return { component: selector, focus: selector };
		});
	}

	async #redeemReset(account: ResetUsageAccount): Promise<void> {
		this.ctx.showStatus(`Spending 1 saved reset for ${account.label}…`, { dim: true });
		let outcome: ResetCreditRedeemOutcome;
		try {
			outcome = await this.ctx.session.redeemResetCredit(account.target);
		} catch (error) {
			this.ctx.showError(`Reset failed for ${account.label}: ${errorMessage(error)}`);
			return;
		}
		const message = describeRedeemOutcome(outcome, account.label);
		if (outcome.ok) {
			this.ctx.showStatus(message);
			// Refresh the status-line usage so the freshly-reset window shows.
			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		} else {
			this.ctx.showWarning(message);
		}
	}

	async showDebugSelector(): Promise<void> {
		const { DebugSelectorComponent } = await import("../../debug");
		this.showModalSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}
}
