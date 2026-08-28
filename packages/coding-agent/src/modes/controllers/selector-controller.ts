import { ThinkingLevel } from "@veyyon/agent-core";
import type { CredentialHealthResult, UsageReport } from "@veyyon/ai";
import type { InstrumentationLevel } from "@veyyon/ai/instrumentation";
import type { OAuthProvider } from "@veyyon/ai/oauth/types";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@veyyon/ai/registry/derived";
import type { Component, OverlayHandle } from "@veyyon/tui";
import { Loader, Spacer, setTuiTight, Text } from "@veyyon/tui";
import { errorMessage, getActiveAuthDbPath, getProjectDir, normalizePathForComparison } from "@veyyon/utils";
import * as logger from "@veyyon/utils/logger";
import {
	type AdvisorConfigScope,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
	type WatchdogConfigDoc,
} from "../../advisor";
import { isRollbackSupported, rollbackToVersion } from "../../cli/update-cli";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveAdvisorRoleSelection,
} from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT, getRoleInfo, isDefaultModelSlot } from "../../config/model-roles";
import { applySamplingKnob, optionalNumber, toNumberOrUndefined } from "../../config/optional-number";
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
import { BackgroundSessions } from "../../session/background-sessions";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { formatProviderName } from "../../slash-commands/helpers/format";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "../../slash-commands/helpers/reset-usage";
import type { SubcommandDef } from "../../slash-commands/types";
import { frozenGateNotice } from "../../system-prompt-builder/gate-registry";
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
import { AdvisorConfigOverlayComponent } from "../components/advisor-config";
import { AgentDashboard } from "../components/agent-dashboard";
import { AssistantMessageComponent } from "../components/assistant-message";
import { CopySelectorComponent } from "../components/copy-selector";
import { ExtensionDashboard } from "../components/extensions";
import { HistorySearchComponent } from "../components/history-search";
import { LoginDialogComponent } from "../components/login-dialog";
import { ModelHubComponent } from "../components/model-hub";
import { ModelPickerComponent } from "../components/model-picker";
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

export type SelectorControllerContext = Pick<
	InteractiveModeContext,
	| "applyCwdChange"
	| "attachMainSession"
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

interface AccountProbeCache {
	health: Map<number, CredentialHealthResult>;
	usage: UsageReport[] | null;
}

type LoginOutcome = "stored" | "cancelled" | "failed";

export class SelectorController {
	constructor(private ctx: SelectorControllerContext) {}

	focusActiveEditorArea(): void {
		const visible = this.ctx.editorContainer.children[0] ?? this.ctx.editor;
		this.ctx.ui.setFocus(visible);
	}

	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
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

	showModalSelector(
		create: (done: () => void) => {
			component: Component & { setOnRequestRender?: (cb: () => void) => void; dispose?: () => void };
			focus: Component;
		},
	): void {
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;
		let closeRequestedEarly = false;
		let card: { dispose?: () => void } | undefined;
		const done = () => {
			if (closed) return;
			if (!overlayHandle) {
				closeRequestedEarly = true;
				return;
			}
			closed = true;
			overlayHandle.hide();
			card?.dispose?.();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const { component, focus } = create(done);
		card = component;
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
			isRollbackSupported(),
		]).then(([availableThemes, availablePersonalities, rollbackSupported]) => {
			let overlayHandle: OverlayHandle | undefined;
			let selector: SettingsSelectorComponent | undefined;
			const done = () => {
				overlayHandle?.hide();
				selector?.dispose();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: this.ctx.session.getAvailableThinkingLevels().slice(),
					thinkingLevel: this.ctx.session.thinkingLevel,
					availableThemes,
					availablePersonalities,
					providers: Array.from(new Set(this.ctx.session.getAvailableModels().map(model => model.provider))).sort(
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

	async showAdvisorConfigure(): Promise<void> {
		const dirs = {
			projectDir: this.ctx.sessionManager.getCwd(),
			agentDir: this.ctx.settings.getAgentDir(),
		};
		const loadDoc = async (scope: AdvisorConfigScope): Promise<WatchdogConfigDoc> =>
			loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs));
		let doc: WatchdogConfigDoc;
		try {
			doc = await loadDoc("project");
		} catch (err) {
			this.ctx.showError(`Failed to read the advisor configuration: ${errorMessage(err)}`);
			return;
		}
		const advisorRole = resolveAdvisorRoleSelection(
			this.ctx.settings,
			this.ctx.session.modelRegistry.getAvailable(),
			this.ctx.session.agent.state.model,
		);
		let overlay: OverlayHandle | undefined;
		const component = new AdvisorConfigOverlayComponent(
			this.ctx.ui,
			{
				modelRegistry: this.ctx.session.modelRegistry,
				settings: this.ctx.settings,
				scopedModels: this.ctx.session.scopedModels,
				availableToolNames: this.ctx.session.getAdvisorAvailableToolNames(),
				defaultModelLabel: advisorRole
					? formatModelSelectorValue(formatModelStringWithRouting(advisorRole.model), advisorRole.thinkingLevel)
					: undefined,
			},
			"project",
			doc,
			{
				loadDoc,
				save: async (scope, next) => {
					await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), next);
					const merged = await discoverAdvisorConfigs(dirs.projectDir, dirs.agentDir);
					const live = this.ctx.session.applyAdvisorConfigs(merged.advisors, merged.sharedInstructions);
					this.ctx.showStatus(
						this.ctx.session.isAdvisorEnabled()
							? `Advisor configuration saved — ${live} advisor${live === 1 ? "" : "s"} running.`
							: "Advisor configuration saved. The advisor is off; turn it on with /advisor on.",
					);
				},
				close: () => {
					overlay?.hide();
					this.focusActiveEditorArea();
					this.ctx.ui.requestRender();
				},
				requestRender: () => {
					this.ctx.ui.requestRender();
				},
				notify: message => {
					this.ctx.showStatus(message);
				},
			},
		);
		overlay = this.ctx.ui.showOverlay(component, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(component);
		this.ctx.ui.requestRender();
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
			);
			return { component, focus: component };
		});
	}

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
			);
			return { component, focus: component };
		});
	}

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
			);
			return { component, focus: component };
		});
	}

	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows);
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		dashboard.onClose = () => {
			overlay.hide();
			dashboard.dispose();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.setOnRequestRender(() => {
			this.ctx.ui.requestRender();
		});
	}

	showAgentsDashboard(
		observers: SessionObserverRegistry,
		options?: { requireContent?: boolean; processScope?: boolean },
	): void {
		const dashboard = new AgentDashboard({
			terminalHeight: this.ctx.ui.terminal.rows,
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
			scope: this.ctx.sessionManager.getSessionId(),
			processScope: options?.processScope,
			focusAgent: id => this.ctx.focusAgentSession(id),
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			expandArgot: entries => this.ctx.session.expandArgotEntries(entries),
		});
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};

		const show = () => {
			const overlay = this.ctx.ui.showOverlay(dashboard, {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0,
				fullscreen: true,
			});
			dashboard.onClose = () => {
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

	handleSettingChange(id: string, value: unknown): void | Promise<void> {
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		if (id === "profileSharing") {
			this.ctx.showWarning(
				"Credential sharing changed. Restart required; this session is shutting down before further model dispatch.",
			);
			return this.ctx.shutdown().catch(err => {
				this.ctx.showError(`Failed to shut down after changing credential sharing: ${errorMessage(err)}`);
			});
		}

		const frozen = frozenGateNotice(id);
		if (frozen !== undefined) this.ctx.showWarning(frozen);

		if (id.startsWith("secrets.")) {
			return this.ctx.session.refreshSecrets().catch(err => {
				this.ctx.showError(`Failed to apply "${id}" to the secret runtime: ${errorMessage(err)}`);
			});
		}

		switch (id) {
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

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;

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
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.collapseCompacted":
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

			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;
		}
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#showModelPicker(options?.temporaryOnly === true);
	}

	#surfaceThemeResult(result: ThemeLoadResult, attempted: string): void {
		if (result.success) return;
		const detail = result.error ? `: ${result.error}` : "";
		this.ctx.showError(
			result.fellBack
				? `Failed to ${attempted}${detail}\nFell back to the ${FALLBACK_THEME_NAME} theme.`
				: `Failed to ${attempted}${detail}`,
		);
	}

	#showModelPicker(temporaryOnly: boolean): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const current = this.ctx.session.model;
		let overlayHandle: OverlayHandle | undefined;
		let picker: ModelPickerComponent | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			picker?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		picker = new ModelPickerComponent(
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
			},
		);
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

	#showModelHub(hubOptions: { initialProviderId?: string }): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		let overlayHandle: OverlayHandle | undefined;
		let hub: ModelHubComponent | undefined;
		let closed = false;
		const done = () => {
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

	async #loginThenReopenModelHub(providerId: string): Promise<void> {
		if ((await this.#handleOAuthLogin(providerId)) === "stored") {
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
		let selector: CopySelectorComponent | undefined;
		const done = () => {
			overlayHandle?.hide();
			selector?.dispose();
			this.ctx.ui.requestRender();
		};
		selector = new CopySelectorComponent(targets, {
			onPick: target => {
				done();
				if (target.content === undefined) return;
				void copyToClipboard(target.content);
				this.ctx.showStatus(target.copyMessage ?? "Copied to clipboard");
			},
			onCancel: done,
		});

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

		this.showModalSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				async entryId => {
					if (entryId === realLeafId) {
						done();
						this.ctx.showStatus("Already at this point");
						return;
					}

					done(); // Close selector first

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
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								continue;
							}
						}

						break;
					}

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
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

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
		const historyStorage = this.ctx.historyStorage;
		const historyMatcher = historyStorage ? (query: string) => historyStorage.matchingSessionIds(query) : undefined;
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
		const live = BackgroundSessions.global().take(sessionPath);
		if (live) {
			const liveCwd = live.sessionManager.getCwd();
			this.ctx.attachMainSession(live);
			if (normalizePathForComparison(liveCwd) !== normalizePathForComparison(previousCwd)) {
				await this.ctx.applyCwdChange(liveCwd);
			}
			this.#refreshSessionTerminalTitle();
			this.ctx.updateEditorBorderColor();
			this.ctx.renderInitialMessages({ clearTerminalHistory: true });
			await this.ctx.reloadTodos();
			this.ctx.showStatus(live.isStreaming ? "Resumed a session that is still running" : "Resumed session");
			return;
		}

		await this.ctx.session.switchSession(sessionPath);
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		if (movedProject) {
			await this.ctx.applyCwdChange(newCwd);
		}
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

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

		await storage.deleteSessionWithArtifacts(sessionFile);

		this.ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}

	async #handleOAuthLogin(providerId: string): Promise<LoginOutcome> {
		const providerLabel = formatProviderName(providerId);
		this.ctx.showStatus(`Logging in to ${providerLabel}…`);
		const manualInput = this.ctx.oauthManualInput;
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		let restored = false;
		let overlayHandle: OverlayHandle | undefined;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			overlayHandle?.hide();
			dialog.dispose();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const dialog = new LoginDialogComponent(
			this.ctx.ui,
			providerId,
			(_success, message) => {
				restoreEditor();
				if (message) this.ctx.showStatus(message);
			},
			{ getTerminalRows: () => this.ctx.ui.terminal.rows },
		);
		overlayHandle = this.ctx.ui.showOverlay(dialog, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(dialog);
		this.ctx.ui.requestRender();
		try {
			const identity = await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
					if (useManualInput) {
						dialog.showProgress(MANUAL_LOGIN_TIP);
					}
				},
				onPrompt: (prompt: { message: string; placeholder?: string; secret?: boolean }) =>
					dialog.showPrompt(prompt),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},
				onManualCodeInput: useManualInput ? () => manualInput.waitForInput(providerId) : undefined,
				onSuccessPage: (url: string) => {
					openPath(url);
				},
			});
			this.ctx.session.modelRegistry.refreshInBackground();
			const accountName = await this.#offerAccountName(dialog, providerId, providerLabel, identity?.credentialId);
			const block = new TranscriptBlock();
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
			return "stored";
		} catch (error: unknown) {
			if (dialog.signal.aborted) {
				return "cancelled";
			}
			this.ctx.showError(`Login failed: ${errorMessage(error)}`);
			return "failed";
		} finally {
			if (useManualInput) {
				manualInput.clear(`Manual OAuth input cleared for ${providerId}`);
			}
			restoreEditor();
		}
	}

	async #offerAccountName(
		dialog: LoginDialogComponent,
		providerId: string,
		providerLabel: string,
		credentialId: number | undefined,
	): Promise<string | undefined> {
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

	async #handleCredentialLogout(providerId: string, credentialId: number, label: string): Promise<void> {
		const providerLabel = formatProviderName(providerId);
		try {
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.removeCredential(providerId, credentialId);
			if (!removed) {
				this.ctx.showError(`Logout skipped: ${label} is no longer stored for ${providerLabel}.`);
				return;
			}

			await this.ctx.session.modelRegistry.refresh();
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Successfully logged out ${label} from ${providerLabel}`),
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

	async showLogin(providerId?: string): Promise<void> {
		if (providerId) {
			if ((await this.#handleOAuthLogin(providerId)) === "stored") await this.showAccountManager(providerId);
			return;
		}
		await this.showAccountManager();
	}

	async showLogout(providerId?: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.reload();
		} catch (error: unknown) {
			this.ctx.showError(`Could not load stored credentials: ${errorMessage(error)}`);
			return;
		}
		if (providerId) {
			if (authStorage.listStoredCredentials(providerId).length === 0) {
				const source = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
				const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
				this.ctx.showError(`Logout skipped: no stored credentials for ${formatProviderName(providerId)}.${suffix}`);
				return;
			}
			await this.showAccountManager(providerId);
			return;
		}
		if (authStorage.listStoredCredentials().length === 0) {
			this.ctx.showStatus("No stored provider credentials to log out. Remove env or config auth at its source.");
			return;
		}
		await this.showAccountManager();
	}

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
		const probes: AccountProbeCache = { health: new Map(), usage: null };
		const reload = () => {
			if (closed) return;
			let inventory = applyCredentialHealth(buildAccountInventory(authStorage, { sessionId }), [
				...probes.health.values(),
			]);
			if (probes.usage) inventory = applyUsageReports(inventory, probes.usage);
			manager?.setInventory(inventory);
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
				onRefresh: (_provider, row) => {
					void this.#probeAccountHealth(
						() => manager,
						() => closed,
						probes,
						row ? [row.credentialId] : undefined,
					);
				},
				onLogout: row => {
					void (async () => {
						await this.#handleCredentialLogout(row.provider, row.credentialId, accountDisplayLabel(row));
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
				onClearRateLimitBlock: row => {
					authStorage.clearCredentialBlocks(row.provider, row.credentialId);
					void this.#probeAccountHealth(
						() => manager,
						() => closed,
						probes,
						[row.credentialId],
					);
					reload();
					this.ctx.showStatus(
						`${row.providerLabel}: cleared the rate-limit hold on ${accountDisplayLabel(row)} and re-checked it`,
					);
				},
				onCancel: done,
			},
			{
				initialProviderId: providerId,
				loadBalancing: this.ctx.session.settings.get("accounts.loadBalancing") === true,
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
			probes,
		);
	}

	async #loginThenReopenAccountManager(providerId: string): Promise<void> {
		if ((await this.#handleOAuthLogin(providerId)) !== "failed") await this.showAccountManager(providerId);
	}

	async #probeAccountHealth(
		getManager: () => AccountManagerComponent | undefined,
		isClosed: () => boolean,
		probes: AccountProbeCache,
		credentialIds?: readonly number[],
	): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		const sessionId = this.ctx.session.sessionId;
		const baseUrlResolver = (target: string) => this.ctx.session.modelRegistry.getProviderBaseUrl?.(target);
		const [health, usage] = await Promise.all([
			authStorage
				.checkCredentials(credentialIds ? { baseUrlResolver, credentialIds } : { baseUrlResolver })
				.catch(error => {
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
		for (const result of health) probes.health.set(result.id, result);
		if (usage) probes.usage = usage;
		let inventory = applyCredentialHealth(await loadAccountInventory(authStorage, { sessionId }), [
			...probes.health.values(),
		]);
		if (probes.usage) inventory = applyUsageReports(inventory, probes.usage);
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
