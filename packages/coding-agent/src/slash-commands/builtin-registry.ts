import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { type AutocompleteItem, DEFAULT_MASK_CHAR, Spacer } from "@veyyon/tui";
import {
	APP_NAME,
	CHANGELOG_URL,
	collapseWhitespace,
	getActiveProfile,
	getAgentDir,
	getGlobalConfigRootDir,
	getProjectDir,
	listProfiles,
	truncate,
} from "@veyyon/utils";
import { COLLAB_GUEST_ALLOWED_COMMANDS, CollabGuestLink } from "../collab/guest";
import { CollabHost } from "../collab/host";
import { DEFAULT_EFFORT_POINTER } from "../config/effort-resolver";
import { modelResolutionFailureMessage } from "../config/model-resolution-failure";
import { expandRoleAlias, getModelMatchPreferences, resolveCliModel } from "../config/model-resolver";
import { PRIORITY_TIER_COMMAND_LABEL, PRIORITY_TIER_LABEL } from "../config/service-tier";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../config/settings-instance";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers.js";
import { shareSession } from "../export/share";
import { PluginManager } from "../extensibility/plugins";
import { buildMemoryPayloadForDisplay, resolveMemoryBackend } from "../memory-backend";
import { runPauseScreen } from "../modes/components/pause-screen";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { extractLastCodeBlock, extractLastCommand } from "../modes/utils/copy-targets";
import type { AgentSession, FreshSessionResult } from "../session/agent-session";
import { parseCompactArgs } from "../session/compact-modes";
import { resolveResumableSession } from "../session/session-listing";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "../thinking";
import { expandTilde, resolveToCwd } from "../tools/path-utils";
import { urlHyperlinkAlways } from "../tui";
import { copyToClipboard } from "../utils/clipboard";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
	type BuiltinSlashCommandName,
} from "./builtin-declarations";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { buildContextReportText } from "./helpers/context-report";
import { formatDurationCoarse } from "./helpers/format";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import { maskedPromptTitle, namePromptTitle, runSecretCommandForSurface } from "./helpers/secret";
import { handleSshAcp } from "./helpers/ssh";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import type { ProfileCommandPort } from "./profile-command";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	SubcommandDef,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

function refreshStatusLine(ctx: Pick<InteractiveModeContext, "statusLine" | "ui">): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/** `/fast status` label for the active model: "on" when its family is the priority tier, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** `/yolo status` label: "on" when the full permission bypass is active, else "off". */
function formatYoloStatus(session: AgentSession): string {
	return session.isApprovalBypassed() ? "on" : "off";
}

/** Comma-joined thinking-effort choices for the active model, plus `auto`. */
function formatThinkingLevelChoices(session: AgentSession): string {
	return [...session.getAvailableThinkingLevels(), AUTO_THINKING].join(", ");
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	return truncate(collapseWhitespace(value), limit);
}

function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

/** Scheme-less display form of a browser deep link: accent + underline, OSC-8 linked to the full URL. */
function collabWebLinkClickable(webLink: string): string {
	const display = theme.fg("accent", `\x1b[4m${webLink.replace(/^https?:\/\//, "")}\x1b[24m`);
	return urlHyperlinkAlways(webLink, display);
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
function collabLinkHint(host: CollabHost, heading: string, view = false): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	return [
		theme.fg("success", heading),
		` ${bullet} ${theme.fg("muted", view ? "Watch from another terminal:" : "Join from another terminal:")} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", "or any web browser:")} ${collabWebLinkClickable(webLink)}`,
		theme.fg(
			"dim",
			view
				? "Anyone with this link can watch the session but cannot prompt the agent."
				: "Anyone with the link can read the session and prompt the agent. Read-only link: /collab view",
		),
	].join("\n");
}

function showCollabQrCode(ctx: Pick<InteractiveModeContext, "present" | "showError">, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(`Failed to render collab QR code: ${errorMessage(err)}`);
	}
}

function showCollabLink(
	ctx: Pick<InteractiveModeContext, "present" | "showError" | "showStatus">,
	host: CollabHost,
	heading: string,
	view = false,
): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return `Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`;
}

const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(`Could not load saved resets: ${errorMessage(error)}`);
		return;
	}
	if (accounts.length === 0) {
		await output("No Codex accounts found. Use /login to add one.");
		return;
	}
	const targetArg = arg.trim();
	if (!targetArg) {
		const lines = ["Saved Codex rate-limit resets:"];
		for (const account of accounts) {
			const detail = account.error ? `unavailable (${account.error})` : `${account.availableCount} available`;
			lines.push(`- ${account.label}: ${detail}${account.active ? " (active)" : ""}`);
		}
		lines.push("", "Spend one with `/usage reset <account email>` or `/usage reset active`.");
		await output(lines.join("\n"));
		return;
	}
	const wanted = targetArg.toLowerCase();
	const target =
		wanted === "active"
			? accounts.find(account => account.active)
			: accounts.find(
					account =>
						account.label.toLowerCase() === wanted ||
						account.target.email?.toLowerCase() === wanted ||
						account.target.accountId?.toLowerCase() === wanted,
				);
	if (!target) {
		await output(`No Codex account matches "${targetArg}".`);
		return;
	}
	if (target.availableCount <= 0) {
		await output(`${target.label}: no saved resets to spend.`);
		return;
	}
	const outcome = await session.redeemResetCredit(target.target);
	await output(describeRedeemOutcome(outcome, target.label));
}

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	return { error: `Unknown /shake mode "${verb}". Use elide or images.` };
}

/**
 * What each builtin command DOES, keyed by the name it is declared under.
 *
 * The declarations live in `builtin-declarations.ts`, which imports nothing; a handler body reaches
 * the whole application, which is why the two halves are separate files. The `Record` is keyed by
 * `BuiltinSlashCommandName`, the union derived from the declaration array, so a handler for a command
 * that does not exist and a command with no handler are both COMPILE ERRORS rather than something a
 * test has to notice. That is what makes this one place for the names rather than two lists.
 */
/** The declaration a name was declared under, recovered from the array by that name. */
type DeclarationNamed<Name extends BuiltinSlashCommandName> = Extract<
	(typeof BUILTIN_SLASH_COMMAND_DECLARATIONS)[number],
	{ readonly name: Name }
>;

/**
 * What one command's handler set may contain, decided by whether its DECLARATION says `textMode`.
 *
 * `textMode: true` means an ACP or RPC client can drive the command, and three consumers read that
 * flag to answer "which commands may a text client see": the ACP advertisement, the reserved-name set
 * that keeps an extension from shadowing a builtin, and the available-commands list. Those consumers
 * used to answer it here instead, with `command.handle !== undefined`, which cost them all 67 handler
 * bodies and the application behind them.
 *
 * Moving the question to the declaration would ordinarily create a second place to keep in sync, so
 * this type removes the choice: a declared `textMode` REQUIRES `handle`, and its absence FORBIDS
 * `handle` with `never`. Adding a text-mode handler without declaring the flag, or declaring the flag
 * without writing the handler, are both compile errors, so the flag cannot drift from the fact it
 * stands for.
 */
type HandlerSetFor<Name extends BuiltinSlashCommandName> =
	DeclarationNamed<Name> extends { readonly textMode: true }
		? Required<Pick<SlashCommandSpec, "handle">> &
				Pick<SlashCommandSpec, "handleTui" | "getTuiAutocompleteDescription">
		: Pick<SlashCommandSpec, "handleTui" | "getTuiAutocompleteDescription"> & { readonly handle?: never };

const BUILTIN_SLASH_COMMAND_HANDLERS: { [Name in BuiltinSlashCommandName]: HandlerSetFor<Name> } = {
	settings: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	statusline: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector("statusLine.preset");
			runtime.ctx.editor.setText("");
		},
	},
	welcome: {
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showFullWelcome();
			runtime.ctx.editor.setText("");
		},
	},
	lsp: {
		handleTui: async (_command, runtime) => {
			const servers = runtime.ctx.lspServers ?? [];
			if (servers.length === 0) {
				// Explain WHY the list is empty: distinguish "no matching project"
				// from "project detected but the server binary is not installed".
				const { loadConfig } = await import("../lsp/config");
				const missing = loadConfig(process.cwd()).missingServers;
				if (missing.length > 0) {
					const lines = [
						"No language servers running. Detected for this project but not installed:",
						...missing.map(
							server =>
								`${theme.fg("warning", theme.status.pending)} ${server.name} ${theme.fg("dim", `(needs \`${server.command}\` on $PATH · ${server.fileTypes.join(", ")})`)}`,
						),
					];
					runtime.ctx.showStatus(lines.join("\n"), { dim: false });
				} else {
					runtime.ctx.showStatus("No language servers configured for this project.");
				}
			} else {
				const glyph = (status: string) =>
					status === "ready"
						? theme.fg("success", theme.status.enabled)
						: status === "error"
							? theme.fg("error", theme.status.error)
							: status === "connecting"
								? theme.fg("warning", theme.status.pending)
								: theme.fg("dim", theme.status.info);
				const lines = servers.map(
					server =>
						`${glyph(server.status)} ${server.name} ${theme.fg("dim", `(${server.status} · ${server.fileTypes.join(", ")})`)}`,
				);
				runtime.ctx.showStatus(lines.join("\n"), { dim: false });
			}
			runtime.ctx.editor.setText("");
		},
	},
	setup: {
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`Usage: /${command.name} [providers]`);
			}
			runtime.ctx.editor.setText("");
		},
	},
	plan: {
		// Palette rows lead with what the command DOES; live state is secondary
		// context after the dot. "Plan: off" told a new user nothing.
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("plan.enabled")) return "Toggle plan mode · disabled in settings";
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return `Toggle plan mode · on${planFile ? ` (${path.basename(planFile)})` : ""}`;
			}
			if (runtime.ctx.goalModeEnabled) return "Toggle plan mode · blocked by goal mode";
			return "Toggle plan mode · off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	"plan-review": {
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled
				? "Re-open the latest plan review"
				: "Re-open the latest plan review · needs plan mode",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	vibe: {
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return "Toggle vibe mode · on";
			if (runtime.ctx.planModeEnabled) return "Toggle vibe mode · blocked by plan mode";
			if (runtime.ctx.goalModeEnabled) return "Toggle vibe mode · blocked by goal mode";
			return "Toggle vibe mode · off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleVibeModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	goal: {
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled")) return "Toggle goal mode · disabled in settings";
			if (runtime.ctx.planModeEnabled) return "Toggle goal mode · blocked by plan mode";
			const state = runtime.ctx.session.getGoalModeState();
			return state
				? `Toggle goal mode · ${state.goal.status} (${shortDetail(state.goal.objective)})`
				: "Toggle goal mode · off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGoalModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	"guided-goal": {
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGuidedGoalCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	loop: {
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "Toggle loop mode · off";
			if (runtime.ctx.loopLimit) return `Toggle loop mode · on (${describeLoopLimitRuntime(runtime.ctx.loopLimit)})`;
			if (runtime.ctx.loopPrompt) return "Toggle loop mode · on (repeating prompt)";
			return "Toggle loop mode · on (waiting for next prompt)";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	queue: {
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(command.args);
		},
	},
	model: {
		// Action first, state second: the palette row must say what the command
		// DOES; the current model is secondary context, not the description.
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Switch model · now ${model.provider}/${model.id}` : "Switch model";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	switch: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector({ temporaryOnly: true });
			runtime.ctx.editor.setText("");
		},
	},
	thinking: {
		getTuiAutocompleteDescription: runtime => {
			const level = runtime.ctx.session.configuredThinkingLevel();
			return level ? `Set thinking effort · now ${level}` : "Set thinking effort";
		},
		handle: async (command, runtime) => {
			const available = formatThinkingLevelChoices(runtime.session);
			const arg = command.args.trim();
			if (!arg) {
				const current = runtime.session.configuredThinkingLevel();
				await runtime.output(
					`Effort: ${current ?? "auto"} (this session). Choose one of: ${available}. Usage: /thinking <level>. ${DEFAULT_EFFORT_POINTER}`,
				);
				return commandConsumed();
			}
			const level = parseConfiguredThinkingLevel(arg);
			if (level === undefined) {
				return usage(`Unknown thinking level: ${arg}. Choose one of: ${available}.`, runtime);
			}
			// Session only. A command typed mid-run changes this run; the saved
			// default is a settings edit, so trying an effort never rewrites it (the
			// cycle keybinding already worked this way, and the two disagreeing is
			// what made effort feel "muddled", operator report 2026-07-24).
			runtime.session.setThinkingLevel(level, false);
			await runtime.output(`Effort set to ${level} for this session. ${DEFAULT_EFFORT_POINTER}`);
			await runtime.notifyConfigChanged?.();
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim();
			runtime.ctx.editor.setText("");
			if (!arg) {
				runtime.ctx.showThinkingSelector();
				return;
			}
			const level = parseConfiguredThinkingLevel(arg);
			if (level === undefined) {
				runtime.ctx.showStatus(
					`Unknown thinking level: ${arg}. Choose one of: ${formatThinkingLevelChoices(runtime.ctx.session)}.`,
				);
				return;
			}
			runtime.ctx.session.setThinkingLevel(level, false);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.updateEditorBorderColor();
			runtime.ctx.showStatus(`Effort set to ${level} for this session. ${DEFAULT_EFFORT_POINTER}`);
		},
	},
	fast: {
		getTuiAutocompleteDescription: runtime =>
			`Toggle the ${PRIORITY_TIER_LABEL} tier · ${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`${PRIORITY_TIER_COMMAND_LABEL} ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(
					supported
						? `${PRIORITY_TIER_COMMAND_LABEL} enabled.`
						: `${PRIORITY_TIER_COMMAND_LABEL} is unavailable for the current model.`,
				);
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output(`${PRIORITY_TIER_COMMAND_LABEL} disabled.`);
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`${PRIORITY_TIER_COMMAND_LABEL} is ${formatFastModeStatus(runtime.session)}.`);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`${PRIORITY_TIER_COMMAND_LABEL} ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(
					supported
						? `${PRIORITY_TIER_COMMAND_LABEL} enabled.`
						: `${PRIORITY_TIER_COMMAND_LABEL} is unavailable for the current model.`,
				);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`${PRIORITY_TIER_COMMAND_LABEL} disabled.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`${PRIORITY_TIER_COMMAND_LABEL} is ${formatFastModeStatus(runtime.ctx.session)}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	yolo: {
		getTuiAutocompleteDescription: runtime => `Full permission bypass · ${formatYoloStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(`Full permission bypass is ${formatYoloStatus(runtime.session)}.`);
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setApprovalBypass(false);
				await runtime.output("Full permission bypass off. Approval prompts are back on.");
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			}
			if (!arg || arg === "on" || arg === "toggle") {
				const next = arg === "toggle" || !arg ? !runtime.session.isApprovalBypassed() : true;
				runtime.session.setApprovalBypass(next);
				await runtime.output(
					next
						? "Full permission bypass ON. Every approval prompt is off for this session (explicit deny and plan mode still block)."
						: "Full permission bypass off. Approval prompts are back on.",
				);
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			}
			return usage("Usage: /yolo [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			runtime.ctx.editor.setText("");
			if (arg === "status") {
				runtime.ctx.showStatus(`Full permission bypass is ${formatYoloStatus(runtime.ctx.session)}.`);
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setApprovalBypass(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.updateEditorBorderColor();
				runtime.ctx.showStatus("Full permission bypass off. Approval prompts are back on.");
				return;
			}
			// Any enabling path (bare, `on`, or `toggle` landing on) requires an
			// explicit danger confirmation: this turns off EVERY prompt.
			const enabling = arg === "toggle" ? !runtime.ctx.session.isApprovalBypassed() : true;
			if (!enabling) {
				runtime.ctx.session.setApprovalBypass(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.updateEditorBorderColor();
				runtime.ctx.showStatus("Full permission bypass off. Approval prompts are back on.");
				return;
			}
			if (runtime.ctx.session.isApprovalBypassed()) {
				runtime.ctx.showStatus("Full permission bypass is already on.");
				return;
			}
			const confirmed = await runtime.ctx.showHookConfirm(
				"Turn OFF all permission prompts?",
				"YOLO removes every approval prompt for this session: file writes, shell commands, and network calls run without asking. Explicit per-tool deny rules and plan mode still block. This resets to off when the session ends. Continue?",
			);
			if (!confirmed) {
				runtime.ctx.showStatus("Full permission bypass not enabled.");
				return;
			}
			runtime.ctx.session.setApprovalBypass(true);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.updateEditorBorderColor();
			runtime.ctx.showStatus("YOLO on: all permission prompts are OFF for this session.");
		},
	},
	prewalk: {
		handle: async (_command, runtime) => {
			const rolePattern = expandRoleAlias("@smol", runtime.settings);
			const resolved = resolveCliModel({
				cliModel: rolePattern,
				modelRegistry: runtime.session.modelRegistry,
				preferences: getModelMatchPreferences(runtime.settings),
			});
			if (resolved.error || !resolved.model) {
				return usage(
					resolved.error ?? modelResolutionFailureMessage([rolePattern], runtime.session.modelRegistry),
					runtime,
				);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				return usage(`No API key for ${resolved.model.provider}/${resolved.model.id}`, runtime);
			}
			runtime.session.armPrewalk(resolved.model, resolved.thinkingLevel);
			await runtime.output(
				`Prewalk on: switching to ${resolved.model.provider}/${resolved.model.id} at the next edit/write (todo-gated).`,
			);
			return commandConsumed();
		},
	},
	export: {
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			// Match the interactive `/export` behavior: clipboard aliases are not a
			// valid export target. Without this, the literal value (`copy`,
			// `--copy`, `clipboard`) is passed to `exportToHtml` and becomes the
			// output filename.
			if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
				return usage("Use /dump to copy the session to clipboard.", runtime);
			}
			try {
				const filePath = await runtime.session.exportToHtml(arg || undefined);
				await runtime.output(`Session exported to: ${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	dump: {
		handle: async (_command, runtime) => {
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output("No messages to dump yet.");
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				// Sidecar is best-effort; the transcript is still output below.
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					`LLM request JSON: ${sidecarPath}`,
					"This file persists on disk and may contain raw context/secrets — treat accordingly.",
				);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	share: {
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: runtime.settings.get("share.serverUrl"),
					store: runtime.settings.get("share.store"),
					state: runtime.session.state,
					obfuscator: runtime.settings.get("share.redactSecrets") ? runtime.session.providerRedactor : undefined,
				});
				const lines = [`Share URL: ${result.url}`];
				if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
				if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to share session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	/**
	 * `/secret`: store a credential the agent can use without ever seeing it.
	 *
	 * A thin adapter. Every rule lives in `secrets/secret-command.ts`, which is pure and tested
	 * without a session, so the security-relevant behaviour is not reachable only through a
	 * live TUI. This function parses, runs, then reconciles the two things a stored secret
	 * touches: the running obfuscator (so the value is protected without a restart) and the
	 * model's context (so the agent learns the placeholder exists).
	 */
	secret: {
		/**
		 * Say the state in the autocomplete row, so `/secret` answers "is this on, and what is in it"
		 * without running `/secret list` first.
		 *
		 * Read from the LIVE runtime rather than the settings snapshot, because the runtime is what
		 * decides whether a placeholder is actually being substituted right now. Counting is done
		 * from the obfuscator's named secrets, which is in memory: an autocomplete description is
		 * rendered on a keystroke and cannot go to disk for a vault read. Names are counted, never
		 * listed, since the row is as wide as the terminal and a name list belongs in `list`.
		 */
		getTuiAutocompleteDescription: runtime => {
			const base = "Store a credential the agent can use without ever seeing it";
			const session = runtime.ctx.session;
			if (!session?.secretsEnabled) return `${base} · protection off, adding one turns it on`;
			const stored = session.obfuscator?.namedSecretNames().length ?? 0;
			if (stored === 0) return `${base} · protection on, none stored yet`;
			return `${base} · protection on, ${stored} stored`;
		},
		/**
		 * Text and ACP: no terminal to hide anything on, so there is no prompt. `--from-env` is the
		 * form that never types the credential at all, and `runSecretCommand` says so when a value
		 * is missing rather than reading one into the scrollback.
		 */
		handle: async (command, runtime) => {
			// Let failures cross the ACP boundary. Print mode can then exit unsuccessfully and RPC
			// can return a failed response instead of emitting error prose followed by success.
			const outcome = await runSecretCommandForSurface(command.args ?? "", {
				session: runtime.session,
				sessionManager: runtime.sessionManager,
				settings: runtime.settings,
				cwd: runtime.cwd,
				globalConfigRoot: getGlobalConfigRootDir(),
				agentDir: getAgentDir(),
			});
			await runtime.output(outcome.message);
			return commandConsumed();
		},
		/**
		 * The TUI, which CAN hide what is typed, so `/secret add NAME` opens a masked field.
		 *
		 * THE EDITOR IS CLEARED BEFORE THE VALUE IS READ, not after. Clearing afterwards would
		 * leave the credential in the input buffer for as long as the prompt is open, and a
		 * cancelled prompt would leave it there for good. The prompt is a local dialog, never
		 * raced against a collab guest, so a masked field cannot be answered from another machine.
		 */
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			try {
				const outcome = await runSecretCommandForSurface(command.args ?? "", {
					session: ctx.session,
					sessionManager: ctx.sessionManager,
					settings: ctx.settings,
					cwd: ctx.sessionManager.getCwd(),
					globalConfigRoot: getGlobalConfigRootDir(),
					agentDir: getAgentDir(),
					promptForValue: name =>
						ctx.showHookInput(maskedPromptTitle(name), undefined, { mask: DEFAULT_MASK_CHAR }),
					// Deliberately unmasked: a name is not a credential, and the operator seeing this
					// field echo while the next one hides is what distinguishes the two questions.
					promptForName: () => ctx.showHookInput(namePromptTitle()),
				});
				if (!outcome.cancelled) ctx.showStatus(outcome.message);
			} catch (error) {
				ctx.showWarning(errorMessage(error));
			}
			return commandConsumed();
		},
	},

	collab: {
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) {
				return `Share this session live · hosting (${Math.max(0, runtime.ctx.collabHost.participants.length - 1)} guests)`;
			}
			if (runtime.ctx.collabGuest?.readOnly) return "Share this session live · read-only guest";
			if (runtime.ctx.collabGuest) return "Share this session live · guest";
			return "Share this session live via a relay";
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				if (!ctx.collabHost) {
					ctx.showStatus("Not hosting a collab session");
					return;
				}
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			if (verb === "status") {
				if (ctx.collabHost) {
					const names = ctx.collabHost.participants.map(p =>
						p.role === "host" ? `${p.name} (host)` : p.readOnly ? `${p.name} (view-only)` : p.name,
					);
					ctx.showStatus(`Collab: ${names.join(", ")} — ${collabWebLinkClickable(ctx.collabHost.webLink)}`);
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? "In a collab session as a read-only guest (/leave to exit)"
							: "In a collab session as a guest (/leave to exit)",
					);
				} else {
					ctx.showStatus("Not in a collab session");
				}
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("Already in a collab session as a guest (/leave first)");
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			if (ctx.collabHost) {
				showCollabLink(
					ctx,
					ctx.collabHost,
					view ? "Read-only collab session active" : "Collab session active",
					view,
				);
				return;
			}
			const explicitUrl = knownStartVerb ? rest : args;
			const relayInput = explicitUrl || ctx.settings.get("collab.relayUrl") || "";
			if (!relayInput) {
				ctx.showError(
					"No relay configured. Set collab.relayUrl in /settings or pass one: /collab relay.example.com",
				);
				return;
			}
			// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
			const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
			const webUrl = ctx.settings.get("collab.webUrl") || "";
			const host = new CollabHost(ctx);
			try {
				await host.start(relayUrl, webUrl);
			} catch (err) {
				ctx.showError(`Failed to start collab session: ${errorMessage(err)}`);
				return;
			}
			ctx.collabHost = host;
			showCollabLink(ctx, host, "Collab session started!", view);
		},
	},
	join: {
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const link = command.args.trim();
			if (!link) {
				ctx.showError("Usage: /join <link>");
				return;
			}
			if (ctx.collabHost) {
				ctx.showError("Stop hosting first (/collab stop)");
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("Already in a collab session (/leave first)");
				return;
			}
			try {
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(`Failed to join collab session: ${errorMessage(err)}`);
			}
		},
	},
	leave: {
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) return "Leave the collab session · hosting";
			if (runtime.ctx.collabGuest) return "Leave the collab session · guest";
			return "Leave the collab session · not in collab";
		},
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			if (ctx.collabHost) {
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			ctx.showStatus("Not in a collab session");
		},
	},
	browser: {
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("browser.enabled"))
				return "Toggle browser headless/visible · disabled in settings";
			return runtime.ctx.settings.get("browser.headless")
				? "Toggle browser headless/visible · headless"
				: "Toggle browser headless/visible · visible";
		},
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = runtime.settings.get("browser.enabled");
			if (!enabled) return usage("Browser tool is disabled (enable in settings).", runtime);
			const current = runtime.settings.get("browser.headless");
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage("Usage: /browser [headless|visible]", runtime);
			runtime.settings.set("browser.headless", next);
			const tool = runtime.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (err) {
					// Setting was already mutated; surface the restart failure so the
					// user knows the browser is in an inconsistent state.
					await runtime.output(
						`Browser mode set to ${next ? "headless" : "visible"}, but restart failed: ${errorMessage(err)}`,
					);
					return commandConsumed();
				}
			}
			await runtime.output(`Browser mode: ${next ? "headless" : "visible"}`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless");
			let next = current;
			if (!settings.get("browser.enabled")) {
				runtime.ctx.showWarning("Browser tool is disabled (enable in settings)");
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus("Usage: /browser [headless|visible]");
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless", next);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(`Failed to restart browser: ${errorMessage(error)}`);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(`Browser mode: ${next ? "headless" : "visible"}`);
			runtime.ctx.editor.setText("");
		},
	},
	copy: {
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.session.messages);
				if (!block) {
					runtime.ctx.showStatus("No code block to copy.");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus("Copied code block to clipboard");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.session.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus("No command to copy.");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(`Copied ${lastCommand.kind === "bash" ? "bash command" : "eval code"} to clipboard`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /copy [code|cmd]");
			runtime.ctx.editor.setText("");
		},
	},
	todo: {
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return "Manage the shared todo list · empty";
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return `Manage the shared todo list · ${pending + inProgress} open (${inProgress} in progress, ${completed} done)`;
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	session: {
		handle: async (command, runtime) => {
			if (!command.args || command.args === "info") {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (command.args === "delete") {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete]", runtime);
		},
		handleTui: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || "info";
			if (sub === "delete") {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			// Default: show session info
			await runtime.ctx.handleSessionCommand();
			runtime.ctx.editor.setText("");
		},
	},
	jobs: {
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0))
				return "Show background jobs · none running";
			return `Show background jobs · ${snapshot.running.length} running, ${snapshot.recent.length} recent`;
		},
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "Running Jobs");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDurationCoarse(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "Recent Jobs");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDurationCoarse(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	usage: {
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /usage [show|reset [account|active]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /usage [show|reset [account|active]]");
			runtime.ctx.editor.setText("");
		},
	},
	changelog: {
		handle: async (_command, runtime) => {
			await runtime.output(`Release notes: ${CHANGELOG_URL}`);
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleChangelogCommand();
			runtime.ctx.editor.setText("");
		},
	},
	hotkeys: {
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	tools: {
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0
				? "List the agent's tools · none available"
				: `List the agent's tools · ${active} active / ${all} available`;
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			await runtime.output(all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`).join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	context: {
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return "Show context usage breakdown";
			// Same vocabulary as the status-line gauge: tok/tok in one unit, and the
			// percentage names what it is instead of leaving "17%" to be read as
			// either consumption or room.
			const left = Math.max(0, 100 - Math.round(usage.percent));
			return `Show context usage breakdown · ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)} · ${left}% left`;
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	extensions: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	// `/cockpit` and `/hub` reach this same handler as aliases of `/agents`: one
	// roster, one drill-in. They were separate overlays that showed the same
	// registry through two different renderings and could disagree about what was
	// running.
	agents: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	branch: {
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	fork: {
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	tree: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	login: {
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? `Log in to a provider · waiting for ${runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth"} callback`
				: "Log in to a provider with OAuth",
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	logout: {
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(`Unknown OAuth provider: ${providerId}`);
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	mcp: {
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	ssh: {
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	"new": {
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	fresh: {
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming
				? "Reset provider stream state · unavailable while streaming"
				: "Reset provider stream state (transcript kept)",
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					"Wait for the current response to finish or abort it before refreshing provider state.",
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleFreshCommand();
		},
	},
	drop: {
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},
	compact: {
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			return usage
				? `Compact the session context · ${Math.round(usage.percent)}% used`
				: "Compact the session context";
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			// A retired mode name still compacts, and must never do so quietly.
			if (parsed.notice) await runtime.output(parsed.notice);
			const before = runtime.session.getContextUsage?.();
			const beforeTokens = before?.tokens;
			try {
				await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
			} catch (err) {
				// Compaction precondition failures (no model, already compacted, too
				// small) and provider errors propagate as plain Errors; surface them
				// via runtime.output so they don't fail the ACP prompt turn.
				return usage(`Compaction failed: ${errorMessage(err)}`, runtime);
			}
			const after = runtime.session.getContextUsage?.();
			const afterTokens = after?.tokens;
			if (beforeTokens != null && afterTokens != null) {
				const saved = beforeTokens - afterTokens;
				await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
			} else {
				await runtime.output("Compaction complete.");
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			runtime.ctx.editor.setText("");
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			// A retired mode name still compacts, and must never do so quietly.
			if (parsed.notice) runtime.ctx.showWarning(parsed.notice);
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	shake: {
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	handoff: {
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	resume: {
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			runtime.ctx.editor.setText("");
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const match = await resolveResumableSession(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!match) {
				runtime.ctx.showError(`Session "${sessionArg}" not found`);
				return;
			}
			await runtime.ctx.handleResumeSession(match.session.path);
		},
	},
	btw: {
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	tan: {
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleTanCommand(work);
		},
	},
	omfg: {
		handleTui: async (command, runtime) => {
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	retry: {
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("Nothing to retry");
			}
			runtime.ctx.editor.setText("");
		},
	},
	debug: {
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	memory: {
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await buildMemoryPayloadForDisplay(
						backend,
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || "Memory payload is empty.");
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt("slash-command");
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("Memory consolidation enqueued.");
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? `Memory ${verb} is not available for the ${backend.id} backend.`);
					return commandConsumed();
				}
				case "mm":
					return usage(
						"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						runtime,
					);
				default:
					return usage("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	rename: {
		handle: async (command, runtime) => {
			if (!command.args) return usage("Usage: /rename <title>", runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output("Session name not changed (a user-set name takes precedence).");
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session renamed to ${command.args}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError("Usage: /rename <title>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	move: {
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("Usage: /move <path>", runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(`Not a directory: ${resolvedPath}`, runtime);
				}
			} catch {
				return usage(`Directory does not exist: ${resolvedPath}`, runtime);
			}
			try {
				// One owner moves storage and every cwd-derived runtime input as a
				// transaction. A failed re-scope rolls the storage move back.
				await runtime.session.moveToCwd(resolvedPath);
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
			// Protocol modes still need to re-advertise their cwd-local command
			// surface after the shared session re-scope has completed.
			await runtime.reloadPlugins();
			await runtime.notifyConfigChanged?.();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(command.args || undefined);
		},
	},
	cwd: {
		handle: async (command, runtime) => {
			const current = runtime.sessionManager.getCwd();
			if (!command.args) {
				await runtime.output(
					`${current}\n(session-scoped and ephemeral. For a per-profile default working directory, set session.workdir in /settings › Interaction › Profile on this profile.)`,
				);
				return commandConsumed();
			}
			if (runtime.session.isStreaming) return usage("Cannot change cwd while streaming.", runtime);
			const resolvedPath = resolveToCwd(command.args, current);
			// A relative arg resolves against the SESSION cwd, not the OS cwd or the
			// project root, so name that base in the failure — otherwise `/cwd tmp`
			// from a session rooted elsewhere reads as "tmp doesn't exist" with no clue why.
			const relativeHint = path.isAbsolute(command.args.trim())
				? ""
				: ` (relative paths resolve against the current session cwd ${current}; pass an absolute path to avoid this)`;
			try {
				const st = await fs.stat(resolvedPath);
				if (!st.isDirectory()) {
					return usage(`Not a directory: ${resolvedPath}${relativeHint}`, runtime);
				}
			} catch {
				return usage(`Directory does not exist: ${resolvedPath}${relativeHint}`, runtime);
			}
			try {
				const next = await runtime.session.setCwd(resolvedPath, { validate: true });
				await runtime.output(
					next === current
						? `cwd unchanged: ${next}`
						: `cwd set: ${current} → ${next}\nThis change is session-scoped and ephemeral (it does not persist). For a per-profile default, set session.workdir in /settings › Interaction › Profile on this profile.`,
				);
				await runtime.notifyTitleChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`set cwd failed: ${errorMessage(err)}`, runtime);
			}
		},
	},
	exit: {
		handleTui: shutdownHandlerTui,
	},
	profile: {
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const [{ parseProfileCommand, runProfileSlashCommand }, { resolveVeyyonCommand }] = await Promise.all([
				import("./profile-command"),
				import("../task/veyyon-command"),
			]);
			const ctx = runtime.ctx;
			const port: ProfileCommandPort = {
				showStatus: message => ctx.showStatus(message, { dim: false }),
				showError: message => ctx.showError(message),
				setEditorText: text => ctx.editor.setText(text),
				askDialog: questions => ctx.showAskDialog(questions),
				requestRelaunch: env => {
					const veyyon = resolveVeyyonCommand();
					const argv =
						veyyon.shell && process.platform === "win32"
							? ["cmd.exe", "/c", veyyon.cmd, ...veyyon.args]
							: [veyyon.cmd, ...veyyon.args];
					ctx.requestRelaunch({ argv, env });
				},
				requestShutdown: () => {
					void ctx.shutdown();
				},
			};
			try {
				await runProfileSlashCommand(parseProfileCommand(command.args), port);
			} catch (error) {
				ctx.showError(errorMessage(error));
			}
			return commandConsumed();
		},
	},
	plugins: {
		handle: async (_command, runtime) => {
			const npmManager = new PluginManager();
			const npmPlugins = await npmManager.list();
			if (npmPlugins.length === 0) {
				await runtime.output("No plugins installed");
				return commandConsumed();
			}
			const lines = npmPlugins.map(plugin => {
				const status = plugin.enabled === false ? " (disabled)" : "";
				return `  ${plugin.name}@${plugin.version}${status}`;
			});
			await runtime.output(["npm plugins:", ...lines].join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			try {
				const npm = new PluginManager();
				const npmPlugins = await npm.list();
				if (npmPlugins.length === 0) {
					runtime.ctx.showStatus("No plugins installed");
					return;
				}
				const lines = [
					"npm plugins:",
					...npmPlugins.map(p => {
						const status = p.enabled === false ? " (disabled)" : "";
						return `  ${p.name}@${p.version}${status}`;
					}),
				];
				runtime.ctx.showStatus(lines.join("\n"));
			} catch (err) {
				runtime.ctx.showStatus(`Plugin error: ${errorMessage(err)}`);
			}
		},
	},
	"reload-plugins": {
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output("Plugins reloaded.");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			// Invalidate registry fs caches and the plugin roots cache so
			// listClaudePluginRoots re-reads from disk on next access.
			const projectPath = await resolveActiveProjectRegistryPath(runtime.ctx.sessionManager.getCwd());
			clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
			await runtime.ctx.refreshSlashCommandState();
			await runtime.ctx.session.refreshSshTool({ activateIfAvailable: true });
			runtime.ctx.showStatus("Plugins reloaded.");
			runtime.ctx.editor.setText("");
		},
	},
	force: {
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0
				? "Force the next turn to use a tool · none active"
				: `Force the next turn to use a tool · ${count} active`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	pause: {
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	quit: {
		handleTui: shutdownHandlerTui,
	},
};

/**
 * One command's declared surface joined to its handler.
 *
 * Written out property by property rather than spread, because the declarations are `as const` and
 * therefore deeply readonly, while `SlashCommandSpec` declares `aliases` and `subcommands` as mutable
 * arrays. Copying them is also the honest thing: a consumer that mutated a spec would otherwise be
 * mutating the shared declaration every other consumer reads.
 */
function toSlashCommandSpec(declaration: BuiltinSlashCommandDeclaration): SlashCommandSpec {
	const spec: SlashCommandSpec = {
		name: declaration.name,
		description: declaration.description,
		...BUILTIN_SLASH_COMMAND_HANDLERS[declaration.name as BuiltinSlashCommandName],
	};
	if (declaration.aliases) spec.aliases = [...declaration.aliases];
	if (declaration.allowArgs !== undefined) spec.allowArgs = declaration.allowArgs;
	if (declaration.inlineHint !== undefined) spec.inlineHint = declaration.inlineHint;
	if (declaration.acpDescription !== undefined) spec.acpDescription = declaration.acpDescription;
	if (declaration.acpInputHint !== undefined) spec.acpInputHint = declaration.acpInputHint;
	if (declaration.subcommands) spec.subcommands = declaration.subcommands.map(sub => ({ ...sub }));
	return spec;
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> =
	BUILTIN_SLASH_COMMAND_DECLARATIONS.map(toSlashCommandSpec);

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

// Re-exported for the consumers that already take it from here. `extensibility` takes it from the
// declarations module directly, which is the point of the split: it wants the names, not the app.
export { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "./builtin-declarations";

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 */
function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 */
function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/**
 * Build getArgumentCompletions for /profile: existing profile names (marked
 * active/switch) plus the verb subcommands.
 */
function buildProfileArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trimStart();
		if (prefix.includes(" ")) return null;
		const { readProfileDisplayName } = await import("../cli/profile-cli");
		const active = getActiveProfile() ?? "default";
		const items: AutocompleteItem[] = [];
		for (const profile of listProfiles()) {
			if (!profile.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
			const display = await readProfileDisplayName(profile.name === "default" ? undefined : profile.name);
			items.push({
				value: profile.name,
				label: profile.name,
				description:
					(profile.name === active ? "active" : "switch (fresh session)") +
					(display && display !== profile.name ? ` (${display})` : ""),
			});
		}
		for (const sub of ["list", "new ", "create ", "switch ", "rename to ", "rm ", "delete "]) {
			if (sub.startsWith(prefix.toLowerCase())) {
				items.push({ value: sub, label: sub.trim(), description: "" });
			}
		}
		return items.length > 0 ? items : null;
	};
}

/**
 * Subcommands whose first argument is the name of an already stored secret.
 * `add` is absent on purpose: its name is one the operator is inventing, so
 * offering existing names there would suggest overwriting rather than storing.
 */
const SECRET_NAME_SUBCOMMANDS: Record<string, true> = { rm: true, extend: true };

/**
 * Build getArgumentCompletions for /secret: the verb list first, then the names
 * of stored secrets once the verb is `rm` or `extend`.
 *
 * Without this the operator has to recall an exact name from memory, which is
 * worse here than for any other command: a secret's whole point is that its
 * value is never displayed, so there is nothing on screen to recognise it by,
 * and a mistyped name is a no-op error rather than something the surface can
 * correct. `/secret list` was the only way to recover a name.
 *
 * Names come from the RUNNING obfuscator rather than from the vault on disk.
 * The vault is the authoritative store, but reading it means file I/O plus a
 * decrypt on every keystroke, and `load()` throws on a malformed or
 * key-missing vault, which would turn a bad vault into a crashing dropdown.
 * The obfuscator already holds these names in memory, sorted, and cannot
 * throw. The cost is that completion goes quiet when secret protection is off
 * and no obfuscator exists; `rm` still works when typed in full, so that
 * degrades the convenience without removing the ability to revoke.
 *
 * Never reads or renders a secret VALUE. Names only, which is the same thing
 * `/secret list` already shows.
 */
function buildSecretArgumentCompletions(
	subcommands: SubcommandDef[],
	runtime: TuiSlashCommandRuntime | undefined,
): (prefix: string) => AutocompleteItem[] | null {
	const completeVerb = buildArgumentCompletions(subcommands);
	return (argumentPrefix: string) => {
		const spaceIndex = argumentPrefix.indexOf(" ");
		if (spaceIndex === -1) return completeVerb(argumentPrefix);

		const verb = argumentPrefix.slice(0, spaceIndex).toLowerCase();
		if (SECRET_NAME_SUBCOMMANDS[verb] !== true) return null;

		// No explicit "past the name, into flags" guard: a valid secret name can
		// never contain a space, so once the operator types one the prefix filter
		// below matches nothing and the dropdown closes on its own. A guard here
		// was unreachable, and a negative control proved no test could tell it
		// from its own absence.
		const typedName = argumentPrefix.slice(spaceIndex + 1);

		const names = runtime?.ctx.session.obfuscator?.namedSecretNames() ?? [];
		if (names.length === 0) return null;

		// A verb that still expects arguments after the name keeps the cursor
		// moving, so `extend` lands on `extend NAME ` ready for `--ttl`, while
		// `rm` completes to a finished command. Read off the declared usage
		// rather than naming `extend` again here, so a subcommand that grows a
		// flag does not need this function edited to match.
		const usage = subcommands.find(s => s.name === verb)?.usage ?? "";
		const nameToken = usage.indexOf("<name>");
		const trailer = nameToken >= 0 && usage.slice(nameToken + "<name>".length).trim().length > 0 ? " " : "";

		const wanted = typedName.toLowerCase();
		const matches = names
			.filter(name => name.toLowerCase().startsWith(wanted))
			.map(name => ({
				value: `${verb} ${name}${trailer}`,
				label: name,
				description: verb === "rm" ? "stop this secret being spendable" : "give this secret a fresh lifetime",
			}));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getArgumentCompletions that suggests directories relative to the
 * current project directory. Used by /move so users can Tab-complete the
 * destination directory.
 */
function buildDirectoryArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();

		const cwd = getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (
			prefix === "" ||
			prefix === "." ||
			prefix === "./" ||
			prefix === ".." ||
			prefix === "../" ||
			prefix === "~" ||
			prefix === "~/" ||
			prefix === "/"
		) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else if (expandedPrefix.endsWith("/")) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else {
			const dir = path.dirname(expandedPrefix);
			searchDir = isAbsolute ? dir : path.join(cwd, dir);
			searchPrefix = path.basename(expandedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
				if (entry.name === ".git") continue;

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDirectory) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const displayValue = buildDirectoryCompletionDisplayValue(prefix, absoluteValue, cwd);
				suggestions.push({ value: displayValue, label: `${entry.name}/` });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			// Completion for a half-typed path, re-run on every keystroke: the directory named by an
			// incomplete prefix usually does not exist yet, so failing to list it is the norm rather than an
			// error. Null means "no suggestions", and nothing is cached, so the next keystroke tries again.
			return null;
		}
	};
}
function buildDirectoryCompletionDisplayValue(prefix: string, absoluteValue: string, cwd: string): string {
	// Preserve the user's prefix style where possible, but always return a
	// value that /move can resolve (absolute or relative) without escaping.
	const normalized = path.normalize(absoluteValue);

	if (prefix.startsWith("~/")) {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "~") {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("/")) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("./")) {
		const relative = path.relative(cwd, normalized);
		return `./${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("../")) {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "..") {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}

	// Default: relative to cwd.
	const relative = path.relative(cwd, normalized);
	return `${relative.replaceAll("\\", "/")}/`;
}

/**
 * The ONE owner of / menu grouping: every builtin command's category, keyed by
 * name. The unfiltered / menu renders these as group headers (SelectItem.group
 * via SlashCommand.category); header order follows the first appearance of
 * each category in registry order. A builtin missing here fails the
 * registry-coherence test, so new commands must be categorized at birth.
 */
export const BUILTIN_SLASH_COMMAND_CATEGORIES: Readonly<Record<string, string>> = {
	settings: "setup",
	secret: "setup",
	statusline: "setup",
	welcome: "setup",
	lsp: "setup",
	setup: "setup",
	login: "setup",
	logout: "setup",
	profile: "setup",
	mcp: "setup",
	ssh: "setup",
	extensions: "setup",
	plugins: "setup",
	"reload-plugins": "setup",
	plan: "modes",
	"plan-review": "modes",
	vibe: "modes",
	goal: "modes",
	"guided-goal": "modes",
	loop: "modes",
	queue: "modes",
	prewalk: "modes",
	fast: "modes",
	yolo: "modes",
	pause: "modes",
	model: "model",
	switch: "model",
	thinking: "model",
	force: "model",
	retry: "model",
	share: "share",
	collab: "share",
	join: "share",
	leave: "share",
	export: "share",
	dump: "share",
	copy: "share",
	browser: "workspace",
	cwd: "workspace",
	tools: "workspace",
	agents: "workspace",
	jobs: "workspace",
	usage: "workspace",
	todo: "context",
	context: "context",
	memory: "context",
	compact: "context",
	shake: "context",
	handoff: "context",
	btw: "context",
	tan: "context",
	session: "session",
	new: "session",
	fresh: "session",
	drop: "session",
	resume: "session",
	rename: "session",
	move: "session",
	branch: "session",
	fork: "session",
	tree: "session",
	exit: "session",
	quit: "session",
	changelog: "info",
	hotkeys: "info",
	debug: "info",
	omfg: "info",
};

/**
 * The browse order, owned by `./category-order.ts` and re-exported here because this is the name callers
 * already import. It moved because it is eight strings about presentation, and reaching it through this
 * module means importing every command implementation: the autocomplete paid 1,149 marginal modules for it.
 */
export { BUILTIN_SLASH_COMMAND_CATEGORY_ORDER } from "./category-order";

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
		category: BUILTIN_SLASH_COMMAND_CATEGORIES[command.name],
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.name === "secret" && cmd.subcommands) {
		materialized.getArgumentCompletions = buildSecretArgumentCompletions(cmd.subcommands, runtime);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.subcommands) {
		materialized.getArgumentCompletions = buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.name === "profile") {
		materialized.getArgumentCompletions = buildProfileArgumentCompletions();
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: async () => {
				const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await ctx.refreshSlashCommandState();
				await ctx.session.refreshSshTool({ activateIfAvailable: true });
			},
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
