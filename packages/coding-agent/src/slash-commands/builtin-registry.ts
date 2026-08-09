import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders, type OAuthProviderInfo } from "@veyyon/ai/oauth";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { stripEffortTierSuffix } from "@veyyon/catalog/variant-collapse";
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
	logger,
	nearestNames,
	truncate,
} from "@veyyon/utils";
import { COLLAB_GUEST_ALLOWED_COMMANDS, CollabGuestLink } from "../collab/guest";
import { CollabHost } from "../collab/host";
import { DEFAULT_EFFORT_POINTER } from "../config/effort-resolver";
import { credentialRemedySentence, missingCredentialsMessage } from "../config/missing-credentials";
import { modelResolutionFailureMessage } from "../config/model-resolution-failure";
import {
	expandRoleAlias,
	getModelMatchPreferences,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelFromString,
} from "../config/model-resolver";
import { PRIORITY_TIER_COMMAND_LABEL, PRIORITY_TIER_LABEL } from "../config/service-tier";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import type { Settings } from "../config/settings";
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
import { SECRET_TUI_SUBCOMMANDS } from "../secrets/secret-command";
import {
	type AccountRow,
	accountDisplayLabel,
	accountsForProvider,
	activeSessionAccounts,
	applyCredentialHealth,
	applyUsageReports,
	loadAccountInventory,
} from "../session/account-inventory";
import type { AgentSession, FreshSessionResult, HandoffResult } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { parseCompactArgs } from "../session/compact-modes";
import { resolveResumableSession } from "../session/session-listing";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { configuredThinkingLevelsForModel, parseConfiguredThinkingLevel } from "../thinking";
import { normalizeApprovalMode } from "../tools/approval";
import { AUTONOMY_LABEL, isKnownApprovalMode } from "../tools/approval-modes";
import { expandTilde, resolveToCwd } from "../tools/path-utils";
import { urlHyperlinkAlways } from "../tui";
import { copyToClipboard } from "../utils/clipboard";
import { bareInvocationShowsSubcommands } from "./bare-subcommand";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
	type BuiltinSlashCommandName,
} from "./builtin-declarations";
import { type AccountRoleSources, accountRoleAnnotations, renderAccountStatus } from "./helpers/account-status";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { buildContextReportText } from "./helpers/context-report";
import { applyCpuLimitCommand } from "./helpers/cpu-limit";
import { formatDurationCoarse, formatProviderName } from "./helpers/format";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import {
	maskedPromptHint,
	maskedPromptTitle,
	namePromptHint,
	namePromptTitle,
	runSecretCommandForSurface,
} from "./helpers/secret";
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

/**
 * The rung in force plus where it came from, e.g. `Ask cmds (session)`.
 *
 * The SOURCE is half the answer. "Ask cmds" alone leaves an operator unable to
 * tell a saved preference from a `/permissions` override they set an hour ago,
 * and those two need different actions to change: one is `/settings`, the other
 * is `/permissions reset`.
 *
 * When something OUTRANKS the stored value, the enforced rung is reported and
 * the stored one is named after it. `--yolo` forces `yolo` for the whole run
 * and an active plan session caps to `plan`, and neither is visible in
 * `tools.approvalMode`: reading only the setting, `veyyon --yolo` followed by
 * `/permissions ask` answered "Ask all" about a session running every tool
 * unasked. Saying `Yolo (--yolo, overriding ask)` is the difference between a
 * command that reports state and one that misreports it.
 */
function describeApprovalMode(from: Settings, session?: AgentSession): string {
	const configured = normalizeApprovalMode(from.get("tools.approvalMode"));
	const source = from.getSource("tools.approvalMode");
	const origin = source === "runtime" ? "session" : source === "default" ? "default" : "saved";
	const stored = `${AUTONOMY_LABEL[configured]} (${origin})`;
	const enforced = session ? normalizeApprovalMode(session.effectiveApprovalMode()) : configured;
	if (enforced === configured) return stored;
	const because = enforced === "plan" ? "plan mode" : "--yolo";
	return `${AUTONOMY_LABEL[enforced]} (${because}, overriding ${AUTONOMY_LABEL[configured]} ${origin})`;
}

/**
 * Apply one `/permissions` invocation, shared by the text and TUI surfaces so
 * both accept exactly the same words and report the same sentence.
 *
 * A rung set here is a RUNTIME override: it holds for this session and is never
 * written to config. That is the intended split — the persisted default is
 * chosen once (onboarding, then `/settings`), and a session that needs more or
 * less rope says so without editing anything. `reset` drops the override rather
 * than writing the default back, so the saved value keeps winning afterwards
 * even if it changes.
 */
function applyPermissionsCommand(
	rawArgs: string,
	from: Settings,
	session?: AgentSession,
): { ok: boolean; message: string } {
	const arg = rawArgs.trim().toLowerCase();
	if (!arg || arg === "status") {
		return {
			ok: true,
			message: `Tool approval: ${describeApprovalMode(from, session)}. Change it with /permissions <mode>.`,
		};
	}
	if (arg === "reset" || arg === "default") {
		from.clearOverride("tools.approvalMode");
		return { ok: true, message: `Session override dropped. Tool approval: ${describeApprovalMode(from, session)}.` };
	}
	if (!isKnownApprovalMode(arg)) {
		return {
			ok: false,
			message: "Usage: /permissions [ask|ask-command|auto|yolo|plan|reset]",
		};
	}
	from.override("tools.approvalMode", arg);
	return {
		ok: true,
		message: `Tool approval for this session: ${describeApprovalMode(from, session)}. /permissions reset restores the saved default.`,
	};
}

/**
 * Comma-joined thinking-effort choices for the active model, derived from the
 * catalog row: the row's declared levels plus `off`/`auto` only when the row
 * accepts them. Never the fixed ladder.
 */
function formatThinkingLevelChoices(session: AgentSession): string {
	return configuredThinkingLevelsForModel(session.model).join(", ");
}

/**
 * Why `/effort` has nothing to set on this model, naming the cause. A row
 * whose effort is baked into its id (`gpt-5.4-high`) names the baked tier and
 * points at the base id, where the control lives.
 */
function noThinkingControlMessage(session: AgentSession): string {
	const model = session.model;
	if (!model) return "No model selected.";
	if (!model.reasoning) {
		return `${model.provider}/${model.id} does not reason; there is no effort to set.`;
	}
	const tierBase = stripEffortTierSuffix(model.id);
	if (tierBase !== undefined) {
		const tier = model.id.slice(tierBase.length + 1);
		return `${model.provider}/${model.id} has effort "${tier}" baked into the model id; /effort has nothing to set. Select ${tierBase} to choose an effort.`;
	}
	return `${model.provider}/${model.id} manages reasoning itself; there is no effort to set.`;
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
		await output("No Codex accounts found. Sign in with /login in an interactive veyyon session to add one.");
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
 * The `/account` verbs, read back from the declaration rather than restated.
 *
 * The diagnostic for an unknown verb has to list the real ones, and a hand-written list here would
 * be a second place to add a verb to — which is exactly how a command grows a verb nothing
 * advertises.
 */
const ACCOUNT_VERBS: readonly string[] = BUILTIN_SLASH_COMMAND_DECLARATIONS.flatMap(
	(command: BuiltinSlashCommandDeclaration) =>
		command.name === "account" ? (command.subcommands ?? []).map(sub => sub.name) : [],
);

/**
 * Which providers this session routes to, and for what, as `/account status` annotates them.
 *
 * The three roles are the three ways a provider ends up serving one session: the model the user is
 * looking at, the model subagents run on, and the web-search backend. They are read from the
 * settings the runtime itself obeys, so the block cannot claim a role the router does not honor.
 * `subagent.model` left unset means every subagent INHERITS the session model, which is why the
 * main provider is annotated for subagents in that case instead of the annotation going missing.
 */
function accountRoleSources(session: AgentSession): AccountRoleSources {
	const model = session.model;
	const subagentProviders: string[] = [];
	const configured = resolveConfiguredModelPatterns(session.settings.get("subagent.model"), session.settings);
	if (configured.length === 0) {
		if (model) subagentProviders.push(model.provider);
	} else {
		const available = session.modelRegistry.getAvailable();
		const preferences = getModelMatchPreferences(session.settings);
		for (const pattern of configured) {
			const resolved = resolveModelFromString(pattern, available, preferences);
			if (resolved) subagentProviders.push(resolved.provider);
		}
	}
	const webSearch = session.settings.get("providers.webSearch");
	return {
		...(model ? { mainModel: { provider: model.provider, id: model.id } } : {}),
		subagentProviders,
		...(typeof webSearch === "string" ? { webSearchPreference: webSearch } : {}),
	};
}

/**
 * The `/account status` block for a session: routing read from disk, usage from the provider.
 *
 * Usage comes through the same `session.fetchUsageReports()` that `/usage` calls, so the two
 * surfaces cannot disagree about a percentage. A failed fetch degrades to the routing-only block
 * rather than failing the command: which account is serving is on disk and still worth printing.
 */
async function buildAccountStatusText(session: AgentSession): Promise<string> {
	let inventory = await loadAccountInventory(session.modelRegistry.authStorage, { sessionId: session.sessionId });
	try {
		const reports = await session.fetchUsageReports();
		if (reports && reports.length > 0) inventory = applyUsageReports(inventory, reports);
	} catch (error) {
		logger.debug("account status: usage fetch failed", { error: errorMessage(error) });
	}
	return renderAccountStatus(inventory, Date.now(), accountRoleAnnotations(accountRoleSources(session))).join("\n");
}

/** How a probed credential reads in the `/account refresh` delta. */
function accountHealthLabel(row: AccountRow | undefined): string {
	if (!row?.health) return "not probed";
	if (row.health === "ok") return "ok";
	if (row.health === "unverifiable") return "unverifiable from here";
	return `failed (${row.healthReason ?? "no reason reported"})`;
}

/**
 * `/account refresh`: re-probe the credentials this session is using and report what moved.
 *
 * Reports a BEFORE → AFTER pair per account rather than the new state alone, because the question
 * a user asks after a 401 is "did the thing I am spending just change", and "ok" on its own does
 * not answer it. Only the routed accounts are named: probing tells the truth about every stored
 * credential, but the ones this session cannot spend are noise in an inline report.
 */
async function refreshActiveAccounts(session: AgentSession): Promise<string> {
	const authStorage = session.modelRegistry.authStorage;
	const before = await loadAccountInventory(authStorage, { sessionId: session.sessionId });
	const routed = activeSessionAccounts(before);
	if (routed.length === 0) {
		return "No provider has routed a request in this session yet, so there is nothing to re-probe.";
	}
	const after = applyCredentialHealth(before, await authStorage.checkCredentials());
	const lines = ["Re-probed the accounts this session is using"];
	let failed = 0;
	for (const row of routed) {
		const probed = accountsForProvider(after, row.provider).find(entry => entry.credentialId === row.credentialId);
		if (probed?.health === "failed") failed += 1;
		const label = `${row.providerLabel} ${accountDisplayLabel(row)}`;
		lines.push(`  ${label}: ${accountHealthLabel(row)} → ${accountHealthLabel(probed)}`);
	}
	lines.push(failed === 0 ? "  Every account in use answered." : `  ${failed} of ${routed.length} failed the probe.`);
	return lines.join("\n");
}

/**
 * `/account name <text>`: name the account THIS session is spending, or clear the name.
 *
 * Scoped to the provider of the current model because that is the only account the command can
 * name without being told which: naming is per credential, and several providers serve one session
 * at once. Empty text CLEARS rather than storing an empty name, so the row falls back to its own
 * identity instead of rendering a blank label.
 *
 * A refused write is reported as a refusal, on the WARNING channel. `setAccountName` returns false
 * when the credential is unknown or the store keeps no names at all (the remote broker), and
 * reporting a save there would leave the user believing a name exists that nothing reads back.
 */
async function renameActiveAccount(session: AgentSession, text: string): Promise<{ ok: boolean; message: string }> {
	const provider = session.model?.provider;
	if (!provider) {
		return { ok: false, message: "No model is active, so no account is routed. Pick one with /model first." };
	}
	const inventory = await loadAccountInventory(session.modelRegistry.authStorage, { sessionId: session.sessionId });
	const rows = accountsForProvider(inventory, provider);
	const row = rows.find(entry => entry.activeForSession) ?? rows.find(entry => entry.selectedForProvider);
	if (!row) {
		return {
			ok: false,
			message: `No ${formatProviderName(provider)} account is serving this session yet. /providers to pick one.`,
		};
	}
	const before = accountDisplayLabel(row);
	const trimmed = text.trim();
	if (!session.modelRegistry.authStorage.setAccountName(provider, row.credentialId, trimmed)) {
		const verb = trimmed ? "name" : "clear the name of";
		return {
			ok: false,
			message: `Could not ${verb} ${before}: the credential is unknown to the store, or this store keeps no account names (remote broker).`,
		};
	}
	const { name: _cleared, ...withoutName } = row;
	const after = accountDisplayLabel(trimmed ? { ...row, name: trimmed } : withoutName);
	const what = trimmed ? "renamed" : "name cleared";
	return { ok: true, message: `${row.providerLabel} account ${what}: ${before} → ${after}` };
}

/** Provider ids that hold accounts, for the `/account switch` diagnostic. */
async function credentialedProviderIds(session: AgentSession): Promise<string[]> {
	const inventory = await loadAccountInventory(session.modelRegistry.authStorage, {
		sessionId: session.sessionId,
	});
	return inventory.providers.map(entry => entry.provider);
}

/**
 * `/account use <provider> <account>`: make one account the machine-wide choice for its provider.
 *
 * The text twin of pressing `enter` on the account card, for the callers that have no card to
 * press: ACP clients, `--print`, and anything driving veyyon from a script. It writes the SAME
 * durable per-provider selection the card writes rather than a session pin, because a caller that
 * cannot see the card also cannot see a choice that quietly expires with the session.
 *
 * An account is named by any of the things an account surface prints for it — the name it was
 * given, its email, its account id, or the label the card renders — matched case-insensitively,
 * exact before prefix. A prefix matching two accounts is REFUSED with both named: picking either
 * one would start spending a subscription the caller did not ask for.
 */
async function useProviderAccount(session: AgentSession, args: string): Promise<{ ok: boolean; message: string }> {
	const parts = args
		.trim()
		.split(/\s+/)
		.filter(part => part.length > 0);
	const providerArg = parts[0];
	const accountArg = parts.slice(1).join(" ");
	if (!providerArg || !accountArg) {
		return { ok: false, message: "Usage: /account use <provider> <account>" };
	}
	const authStorage = session.modelRegistry.authStorage;
	const inventory = await loadAccountInventory(authStorage, { sessionId: session.sessionId });
	const provider = providerArg.toLowerCase();
	const rows = accountsForProvider(inventory, provider);
	if (rows.length === 0) {
		const stored = inventory.providers.map(entry => entry.provider);
		return {
			ok: false,
			message: `No accounts stored for "${providerArg}". Providers with accounts: ${stored.length > 0 ? stored.join(", ") : "none"}.`,
		};
	}
	const needle = accountArg.toLowerCase();
	const names = (row: AccountRow): string[] =>
		[row.name, row.email, row.accountId, accountDisplayLabel(row)]
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map(value => value.toLowerCase());
	const exact = rows.filter(row => names(row).includes(needle));
	const matched = exact.length > 0 ? exact : rows.filter(row => names(row).some(value => value.startsWith(needle)));
	if (matched.length === 0) {
		const known = rows.map(row => accountDisplayLabel(row)).join(", ");
		return {
			ok: false,
			message: `No ${formatProviderName(provider)} account matches "${accountArg}". Stored: ${known}.`,
		};
	}
	if (matched.length > 1) {
		const ambiguous = matched.map(row => accountDisplayLabel(row)).join(", ");
		return {
			ok: false,
			message: `"${accountArg}" matches ${matched.length} accounts: ${ambiguous}. Name one of them exactly.`,
		};
	}
	const row = matched[0] as AccountRow;
	const label = accountDisplayLabel(row);
	if (!authStorage.selectProviderCredential(provider, row.credentialId, { sessionId: session.sessionId })) {
		return { ok: false, message: `Could not switch to ${label}: that account is no longer stored.` };
	}
	return {
		ok: true,
		message: `${row.providerLabel}: now using ${label} everywhere on this machine.`,
	};
}

/** Case- and separator-insensitive provider key: `OpenAI Codex`, `openai-codex` and `openai_codex` agree. */
function foldProviderKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve what an operator typed after `/login` or `/logout` to ONE OAuth provider.
 *
 * Folded over the id AND the display name, because those are the two spellings the product itself
 * puts in front of them: the palette suggests `openai-codex`, the account card says `OpenAI Codex`,
 * and typing either one back is not a mistake. Exact-id matching sent `/login Anthropic` down the
 * pasted-callback path instead, which answered "No OAuth login is waiting for a manual callback":
 * true of a subsystem the operator never mentioned, and no help at all in reaching a login.
 */
function findOAuthProvider(requested: string): OAuthProviderInfo | undefined {
	const wanted = foldProviderKey(requested);
	if (!wanted) return undefined;
	const providers = getOAuthProviders();
	return (
		providers.find(provider => foldProviderKey(provider.id) === wanted) ??
		providers.find(provider => foldProviderKey(provider.name) === wanted)
	);
}

/**
 * Does this text look like an OAuth redirect the operator pasted?
 *
 * It only chooses which REFUSAL to print, never whether a login happens, so a wrong guess costs a
 * less precise sentence and cannot cost a sign-in.
 */
function looksLikeOAuthCallback(text: string): boolean {
	return text.includes("://") || text.includes("code=") || text.startsWith("?");
}

/**
 * Any provider in the registry, resolved the same folded way as an OAuth provider.
 *
 * Naming a provider that plainly exists is what separates "this one does not do browser logins" and
 * "you have nothing stored for it" from "we do not know that name", and those three need three
 * different next steps.
 */
function findRegistryProvider(requested: string): { id: string; login?: unknown } | undefined {
	const wanted = foldProviderKey(requested);
	if (!wanted) return undefined;
	return PROVIDER_REGISTRY.find(
		provider => foldProviderKey(provider.id) === wanted || foldProviderKey(provider.name) === wanted,
	);
}

/** A provider that exists and signs in with an API key rather than a browser. */
function findApiKeyProvider(requested: string): { id: string } | undefined {
	const provider = findRegistryProvider(requested);
	return provider && !provider.login ? provider : undefined;
}

/**
 * What to say after "we do not know that name", for either command.
 *
 * NOT the list of every provider. The first version of this refusal named all of them, and a real
 * recording of it is 57 ids across twelve lines of transcript: a wall an operator scans instead of
 * reads, in answer to what is nearly always a typo. So the near misses come first, through
 * `nearestNames`, the repo's one owner of "what did they probably mean", and the fallback is the
 * picker the command already has, which lists the providers properly and does not have to be
 * remembered. The count stays because it is the one number that tells you the picker is worth
 * opening.
 */
function providerSuggestionSentence(requested: string, command: "login" | "logout"): string {
	const providers = getOAuthProviders();
	const candidates = providers.flatMap(provider => [provider.id, provider.name]);
	const near = nearestNames(requested, candidates, 3);
	const suggestion = near.length > 0 ? `Did you mean ${near.join(", ")}? ` : "";
	return `${suggestion}Run /${command} with no argument to pick from ${providers.length} providers you can sign in to.`;
}

/**
 * Why `/login <text>` could not start, when `text` named no OAuth provider.
 *
 * Three situations that need three different next steps, where the old code gave all three the
 * same one. A provider that exists but authenticates with an API key needs an env var, not a
 * browser. Text shaped like a callback with nothing waiting means that login was already
 * abandoned. Anything else is a typo, and the answer to a typo is the set of names that work.
 */
function loginTargetRefusal(requested: string): string {
	const apiKeyProvider = findApiKeyProvider(requested);
	if (apiKeyProvider) {
		return `${formatProviderName(apiKeyProvider.id)} has no browser login. ${credentialRemedySentence(apiKeyProvider.id)}`;
	}
	if (looksLikeOAuthCallback(requested)) {
		return "No OAuth login is waiting for a manual callback. Start one with /login <provider>.";
	}
	return `Unknown provider "${truncate(requested, 40)}". ${providerSuggestionSentence(requested, "login")}`;
}

/**
 * Why `/logout <text>` could not start, when nothing stored answers to `text`.
 *
 * Reached only after the stored-credential lookup came back empty, so a provider named here is one
 * veyyon knows and has nothing to delete for. Saying it "has no stored login" while the account card
 * listed one and removed it with `x` is the two surfaces disagreeing, which is the defect the
 * resolution order below exists to prevent.
 */
function logoutTargetRefusal(requested: string): string {
	const provider = findRegistryProvider(requested);
	if (provider) {
		return `No stored login for ${formatProviderName(provider.id)} to remove. If it is still serving requests, its credential comes from the environment or the models config, where veyyon cannot delete it for you.`;
	}
	return `Unknown provider "${truncate(requested, 40)}". ${providerSuggestionSentence(requested, "logout")}`;
}

/**
 * The provider a `/logout <text>` should open, or `undefined` when nothing stored answers to it.
 *
 * An OAuth provider always resolves, so `/logout anthropic` still reaches the selector that reports
 * having nothing stored. Beyond that, ANY provider holding a stored credential resolves, because the
 * account card lists those rows and deletes them with `x`: a groq api_key row is visibly removable
 * there, and `/logout groq` refusing it was the command contradicting the card.
 */
function findLogoutProvider(requested: string, authStorage: AuthStorage): string | undefined {
	const oauth = findOAuthProvider(requested);
	if (oauth) return oauth.id;
	const provider = findRegistryProvider(requested);
	if (provider && authStorage.listStoredCredentials(provider.id).length > 0) return provider.id;
	return undefined;
}

/**
 * Log in and add an account, for BOTH spellings that ask for it.
 *
 * `/account login` is the canonical name — accounts have one command now — and `/login` is a
 * permanent alias that calls this same function with the same argument string. One body rather
 * than two, because the two spellings previously drifted: only `/login` accepted a pasted redirect
 * URL, so an operator who reached the account surface through `/account` had no way to finish a
 * login whose browser callback never came back.
 *
 * Three argument shapes, and each one is CLASSIFIED rather than fallen through: a provider (by id
 * or display name) starts that provider's login, any other text is the pending callback when a
 * login is actually waiting for one, and nothing at all opens the picker. Text that is neither is
 * refused by name. The old order treated "not a provider id" as "must be a callback", so every
 * misspelled provider produced a message about manual callbacks.
 */
function startProviderLogin(rawArgs: string, runtime: TuiSlashCommandRuntime): void {
	const manualInput = runtime.ctx.oauthManualInput;
	const args = rawArgs.trim();
	const pendingNotice = (): string => {
		const provider = manualInput.pendingProviderId;
		return provider
			? `OAuth login already in progress for ${formatProviderName(provider)}. Paste the redirect URL with /login <url>.`
			: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
	};
	if (args.length > 0) {
		const matchedProvider = findOAuthProvider(args);
		if (matchedProvider) {
			if (manualInput.hasPending()) {
				runtime.ctx.showWarning(pendingNotice());
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
			runtime.ctx.editor.setText("");
			return;
		}
		if (manualInput.hasPending()) {
			// `submit` refuses only when nothing is pending, which this branch has ruled out.
			manualInput.submit(args);
			runtime.ctx.showStatus("OAuth callback received; completing login…");
			runtime.ctx.editor.setText("");
			return;
		}
		runtime.ctx.showWarning(loginTargetRefusal(args));
		runtime.ctx.editor.setText("");
		return;
	}

	if (manualInput.hasPending()) {
		runtime.ctx.showWarning(pendingNotice());
		runtime.ctx.editor.setText("");
		return;
	}

	void runtime.ctx.showOAuthSelector("login");
	runtime.ctx.editor.setText("");
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
			// The footline's master toggle, not the preset: the toggle is the first row of the
			// group and the preset sits directly underneath it, so opening here reaches both,
			// and it is the row that still exists when the footline has been turned off (the
			// preset hides with it, and a jump to a hidden row falls through to Dark Theme).
			runtime.ctx.showSettingsSelector("statusLine.enabled");
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
				runtime.ctx.showWarning("Usage: /setup [providers]");
			}
			runtime.ctx.editor.setText("");
		},
	},
	providers: {
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showAccountManager();
			runtime.ctx.editor.setText("");
		},
	},
	account: {
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "status") {
				await runtime.output(await buildAccountStatusText(runtime.session));
				return commandConsumed();
			}
			if (verb === "name") {
				await runtime.output((await renameActiveAccount(runtime.session, rest)).message);
				return commandConsumed();
			}
			if (verb === "refresh") {
				await runtime.output(await refreshActiveAccounts(runtime.session));
				return commandConsumed();
			}
			// The text path for the card's `enter`. It is here rather than TUI-only on purpose: the
			// selection it writes is machine-wide and durable, so a caller with no card — ACP,
			// `--print`, a script — must be able to make it too.
			if (verb === "use") {
				await runtime.output((await useProviderAccount(runtime.session, rest)).message);
				return commandConsumed();
			}
			// The one usage renderer, the one `/usage` prints. A second one here would be a second
			// answer to "how much have I spent", and they would drift.
			if (verb === "usage") {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "manager" || verb === "switch" || verb === "logout" || verb === "login") {
				return usage(
					`/account ${verb} opens a view, which needs the interactive TUI. From here: /account status, /account use <provider> <account>, /account name <text>, /account refresh, /account usage.`,
					runtime,
				);
			}
			return usage(`Unknown /account subcommand "${verb}". Use ${ACCOUNT_VERBS.join(", ")}.`, runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			runtime.ctx.editor.setText("");
			if (!verb || verb === "status") {
				runtime.ctx.showStatus(await buildAccountStatusText(runtime.ctx.session), { dim: false });
				return;
			}
			if (verb === "manager") {
				await runtime.ctx.showAccountManager();
				return;
			}
			if (verb === "switch") {
				const requested = rest.trim();
				if (!requested) {
					await runtime.ctx.showAccountManager();
					return;
				}
				// Naming a provider that holds no accounts must SAY so: opening the manager anyway
				// would look like the switch happened, on a provider that cannot serve anything.
				const known = await credentialedProviderIds(runtime.ctx.session);
				if (!known.includes(requested.toLowerCase())) {
					const stored = known.length > 0 ? known.join(", ") : "none";
					runtime.ctx.showWarning(`No accounts stored for "${requested}". Providers with accounts: ${stored}.`);
					return;
				}
				await runtime.ctx.showAccountManager(requested.toLowerCase());
				return;
			}
			if (verb === "name") {
				const renamed = await renameActiveAccount(runtime.ctx.session, rest);
				if (renamed.ok) runtime.ctx.showStatus(renamed.message, { dim: false });
				else runtime.ctx.showWarning(renamed.message);
				return;
			}
			if (verb === "refresh") {
				runtime.ctx.showStatus(await refreshActiveAccounts(runtime.ctx.session), { dim: false });
				return;
			}
			if (verb === "use") {
				const used = await useProviderAccount(runtime.ctx.session, rest);
				if (used.ok) runtime.ctx.showStatus(used.message, { dim: false });
				else runtime.ctx.showWarning(used.message);
				return;
			}
			if (verb === "usage") {
				await runtime.ctx.handleUsageCommand();
				return;
			}
			// The canonical login. `/login` is the alias, and both land on the same function, so
			// `/account login <redirect URL>` finishes a stalled callback exactly as `/login` does.
			if (verb === "login") {
				startProviderLogin(rest, runtime);
				return;
			}
			if (verb === "logout") {
				const requested = rest.trim();
				if (requested) {
					// The same resolver `/login` uses, widened by what is actually stored. One command
					// accepting `OpenAI Codex` while its opposite accepts only `openai-codex` is a
					// difference nothing justifies, and refusing a provider the card removes with `x` is
					// the two surfaces disagreeing about what a stored login is.
					const matched = findLogoutProvider(requested, runtime.ctx.session.modelRegistry.authStorage);
					if (!matched) {
						runtime.ctx.showWarning(logoutTargetRefusal(requested));
						return;
					}
					void runtime.ctx.showOAuthSelector("logout", matched);
					return;
				}
				void runtime.ctx.showOAuthSelector("logout");
				return;
			}
			runtime.ctx.showWarning(`Unknown /account subcommand "${verb}". Use ${ACCOUNT_VERBS.join(", ")}.`);
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
	effort: {
		getTuiAutocompleteDescription: runtime => {
			const level = runtime.ctx.session.configuredThinkingLevel();
			return level ? `Set thinking effort · now ${level}` : "Set thinking effort";
		},
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			const choices = configuredThinkingLevelsForModel(runtime.session.model);
			if (choices.length === 0) {
				await runtime.output(noThinkingControlMessage(runtime.session));
				return commandConsumed();
			}
			const available = formatThinkingLevelChoices(runtime.session);
			if (!arg) {
				const current = runtime.session.configuredThinkingLevel();
				await runtime.output(
					`Effort: ${current ?? "auto"} (this session). Choose one of: ${available}. Usage: /effort <level>. ${DEFAULT_EFFORT_POINTER}`,
				);
				return commandConsumed();
			}
			const level = parseConfiguredThinkingLevel(arg);
			if (level === undefined) {
				return usage(`Unknown thinking level: ${arg}. Choose one of: ${available}.`, runtime);
			}
			if (!choices.includes(level)) {
				return usage(
					`${runtime.session.model?.provider}/${runtime.session.model?.id} does not accept ${level}. Choose one of: ${available}.`,
					runtime,
				);
			}
			// Session only. A command typed mid-run changes this run; the saved default
			// is a settings edit, so trying an effort never rewrites it (the cycle
			// keybinding already worked this way, and the two disagreeing is what made
			// effort feel "muddled").
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
			const choices = configuredThinkingLevelsForModel(runtime.ctx.session.model);
			if (choices.length === 0) {
				runtime.ctx.showStatus(noThinkingControlMessage(runtime.ctx.session));
				return;
			}
			const available = formatThinkingLevelChoices(runtime.ctx.session);
			const level = parseConfiguredThinkingLevel(arg);
			if (level === undefined) {
				runtime.ctx.showStatus(`Unknown thinking level: ${arg}. Choose one of: ${available}.`);
				return;
			}
			if (!choices.includes(level)) {
				runtime.ctx.showStatus(
					`${runtime.ctx.session.model?.provider}/${runtime.ctx.session.model?.id} does not accept ${level}. Choose one of: ${available}.`,
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
	permissions: {
		getTuiAutocompleteDescription: runtime =>
			`Tool approval · ${describeApprovalMode(settings, runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			// `runtime.settings` on the text path and the module proxy on the TUI
			// path are the same instance in every shipped host; the session comes
			// along so both report the ENFORCED rung rather than the stored one.
			const result = applyPermissionsCommand(command.args, runtime.settings, runtime.session);
			if (!result.ok) return usage(result.message, runtime);
			await runtime.output(result.message);
			await runtime.notifyConfigChanged?.();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const result = applyPermissionsCommand(command.args, settings, runtime.ctx.session);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(result.message);
		},
	},
	"cpu-limit": {
		getTuiAutocompleteDescription: () => {
			const cores = settings.get("session.cpuLimitCores");
			const scope = settings.getSource("session.cpuLimitCores") === "runtime" ? "session" : "profile";
			return `Session CPU budget · ${cores > 0 ? `${cores} core(s), ${scope}` : "off"}`;
		},
		handle: async (command, runtime) => {
			const result = await applyCpuLimitCommand(
				command.args,
				runtime.settings,
				runtime.session.sessionManager.getSessionId(),
			);
			if (!result.ok) return usage(result.message, runtime);
			await runtime.output(result.message);
			await runtime.notifyConfigChanged?.();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const result = await applyCpuLimitCommand(
				command.args,
				settings,
				runtime.ctx.session.sessionManager.getSessionId(),
			);
			runtime.ctx.showStatus(result.message);
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
				// `/prewalk` is text-mode, so the remedy has to hold outside a terminal.
				// `missingCredentialsMessage` names the env var, the auth-broker command and the models.yml
				// path, and marks `/login` as the interactive-only shortcut rather than the answer.
				return usage(missingCredentialsMessage(resolved.model.provider, resolved.model.id), runtime);
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
			let sidecarError: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch (error) {
				// The sidecar is the machine-readable half of what `/dump` promises.
				// Dropping it silently handed back a transcript that looks complete,
				// so the operator went looking for a file that was never written.
				sidecarError = errorMessage(error);
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					`LLM request JSON: ${sidecarPath}`,
					"This file persists on disk and may contain raw context/secrets — treat accordingly.",
				);
			else if (sidecarError) lines.push("", `LLM request JSON could not be written: ${sidecarError}`);
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
		 * The TUI, which CAN hide what is typed, so a bare `/secret` opens a masked field.
		 *
		 * THE EDITOR IS CLEARED BEFORE THE VALUE IS READ, not after. That matters far more under
		 * the verbless grammar than it did before: the argument line IS the credential now, so
		 * leaving it in the input buffer would park a live token there for as long as the prompt is
		 * open, and a cancelled prompt would leave it there for good. The prompt is a local dialog,
		 * never raced against a collab guest, so a masked field cannot be answered from another
		 * machine.
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
					promptForValue: () =>
						ctx.showHookInput(maskedPromptTitle(), undefined, {
							mask: DEFAULT_MASK_CHAR,
							hint: maskedPromptHint(),
						}),
					// Deliberately unmasked: a name is not a credential, and the operator seeing this
					// field echo after the hidden one is what distinguishes the two questions.
					promptForName: () => ctx.showHookInput(namePromptTitle(), undefined, { hint: namePromptHint() }),
				});
				// The manager is a screen, so it is opened here rather than returned as text. No
				// status line goes with it: the card that just appeared is the entire answer, and a
				// message underneath it would be reporting on something already on screen.
				if (outcome.openManager) {
					ctx.showSecretManager();
					return commandConsumed();
				}
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
			startProviderLogin(command.args, runtime);
		},
	},
	logout: {
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matched = findLogoutProvider(providerId, runtime.ctx.session.modelRegistry.authStorage);
				if (!matched) {
					runtime.ctx.showWarning(logoutTargetRefusal(providerId));
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matched);
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
			// Retired non-handoff names still compact, and must never do so quietly.
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
			// Retired non-handoff names still compact, and must never do so quietly.
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
		/**
		 * The text-mode half of `/handoff`, so a client without a terminal can run the operation the
		 * `/compact handoff` refusal points it at.
		 *
		 * It mirrors the TUI guard rather than the TUI presentation: the streaming refusal and the
		 * cancellation wording are the same sentences, and what is dropped is the spinner, the
		 * transcript repaint and the editor reset, none of which exist here. `session.handoff` throws
		 * its preconditions ("Nothing to hand off"), so they surface as the failure line instead of
		 * as a success the caller would have to disbelieve.
		 */
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage("Wait for the current response to finish or abort it before handing off.", runtime);
			}
			let result: HandoffResult | undefined;
			try {
				result = await runtime.session.handoff(command.args.trim() || undefined);
			} catch (err) {
				const message = errorMessage(err);
				return usage(message === "Handoff cancelled" ? message : `Handoff failed: ${message}`, runtime);
			}
			if (!result) return usage("Handoff cancelled", runtime);
			// The transcript underneath the caller's session id was replaced, so anything deriving a
			// title from it is now stale.
			await runtime.notifyTitleChanged?.();
			await runtime.output(
				result.savedPath
					? `New session started with handoff context. Handoff document saved to: ${result.savedPath}`
					: "New session started with handoff context.",
			);
			return commandConsumed();
		},
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
					`${current}\n(session-scoped and ephemeral. For a per-profile default working directory, set session.workdir in /settings › Interaction › Profile on this profile, or run: veyyon config set session.workdir <path>.)`,
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
						: `cwd set: ${current} → ${next}\nThis change is session-scoped and ephemeral (it does not persist). For a per-profile default, set session.workdir in /settings › Interaction › Profile on this profile, or run: veyyon config set session.workdir <path>.`,
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
	if (declaration.bareAction !== undefined) spec.bareAction = declaration.bareAction;
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
 * Argument completion for `/secret`, one entry per subcommand the terminal parses.
 *
 * DERIVED, NOT LISTED. `SECRET_TUI_SUBCOMMANDS` is built from the parser's own table of reserved
 * words, so a subcommand cannot be typeable and unoffered, which is what this menu was: it offered
 * `manager` alone while the help text advertised five verbs, and in a terminal those five did not
 * parse at all, so an operator who read the help and typed `/secret list` stored the word `list` as
 * a credential. Both halves of that are fixed together, because either alone is still a lie.
 *
 * NAMES ARE STILL NEVER OFFERED. An earlier version completed the verbs and then the names of
 * stored secrets, so `/secret rm git` offered `GITHUB_TOKEN`; picking one rendered part of the
 * vault on a keystroke, and under the verbless grammar it also stored the whole suggestion as a
 * credential. Choosing a name from a list is what the manager is for.
 *
 * The prefix filter is what keeps the menu out of a paste: a pasted credential arrives as one
 * insert, so the prefix is the entire token and matches nothing. Only a hand-typed word that is
 * genuinely the start of a subcommand opens the dropdown.
 */
const secretArgumentCompletions = (argumentPrefix: string): AutocompleteItem[] | null => {
	if (argumentPrefix.includes(" ")) return null; // past the subcommand
	const prefix = argumentPrefix.toLowerCase();
	const matches = SECRET_TUI_SUBCOMMANDS.filter(sub => sub.name.startsWith(prefix)).map(sub => ({
		value: sub.usage === "" ? sub.name : `${sub.name} `,
		label: sub.name,
		description: sub.description,
		hint: sub.usage === "" ? undefined : sub.usage,
	}));
	return matches.length > 0 ? matches : null;
};

/**
 * The ghost text after `/secret`, which is the only thing on screen before anything is typed.
 *
 * Two hints, because the two moments want different sentences. Empty line: the declared summary of
 * the whole grammar, since the operator has been given a blank field and needs to know a value can
 * go straight into it. Mid-word: the usage of the subcommand being typed, so `/secret ex` completes
 * itself and says it wants a name and a lifetime.
 */
function buildSecretInlineHint(inlineHint: string | undefined): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		if (trimmed.length === 0) return inlineHint ?? null;
		if (trimmed.includes(" ")) {
			const typed = trimmed.slice(0, trimmed.indexOf(" ")).toLowerCase();
			const exact = SECRET_TUI_SUBCOMMANDS.find(sub => sub.name === typed);
			// Only while the argument is still just the verb: past that the operator is typing a name
			// or a credential, and a hint that keeps naming the usage overwrites nothing but reads as
			// if the line were incomplete.
			return exact !== undefined && trimmed.trimEnd() === typed && exact.usage !== "" ? exact.usage : null;
		}
		const match = SECRET_TUI_SUBCOMMANDS.find(sub => sub.name.startsWith(trimmed.toLowerCase()));
		if (match === undefined) return null;
		const remaining = match.name.slice(trimmed.length);
		return match.usage === "" ? remaining : `${remaining} ${match.usage}`;
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
	providers: "setup",
	account: "setup",
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
	permissions: "modes",
	yolo: "modes",
	"cpu-limit": "modes",
	pause: "modes",
	model: "model",
	switch: "model",
	effort: "model",
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
	// `secret` completes the TERMINAL grammar, which is not the declaration's: `add` takes no name
	// here and `manager` is not declared at all, because the declared list is also what an ACP
	// client is told it may run and that client has no screen to open.
	if (cmd.name === "secret") {
		materialized.getArgumentCompletions = secretArgumentCompletions;
		materialized.getInlineHint = buildSecretInlineHint(cmd.inlineHint);
	} else if (cmd.subcommands) {
		materialized.getArgumentCompletions = buildArgumentCompletions(cmd.subcommands);
		// A command may declare both, and until this fell back it declared the static hint into a
		// void: the subcommand hint is null on an empty line, which is the one moment an operator
		// who has typed `/collab ` and nothing else needs to be told what may follow.
		const subcommandHint = buildSubcommandInlineHint(cmd.subcommands);
		const staticHint = cmd.inlineHint === undefined ? undefined : buildStaticInlineHint(cmd.inlineHint);
		materialized.getInlineHint = (argumentText: string) =>
			subcommandHint(argumentText) ?? staticHint?.(argumentText) ?? null;
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
		return text.includes("://") || text.includes("code=") || text.startsWith("?");
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	// A bare `/cmd` with subcommands opens the picker instead of running the handler, unless the
	// declaration claimed the toggle exception. This sits in the DISPATCHER rather than in each
	// handler because the defect it prevents is invisible from inside one: `if (!verb || verb ===
	// "status")` reads as ordinary code, and only the declaration says `status` is a subcommand.
	if (command.subcommands && bareInvocationShowsSubcommands(command, parsed.args)) {
		const subcommands = command.subcommands;
		runtime.ctx.editor.setText("");
		runtime.ctx.showSubcommandPicker(command.name, subcommands, subcommand => {
			// A subcommand that declares a `usage` wants an argument, and running it with an empty
			// one is not what was picked. Prefill the editor instead and leave the cursor after the
			// space: the operator finishes the line and presses enter, which is the same keystroke
			// they would have made had they known the subcommand existed.
			if (subcommand.usage && subcommand.usage.trim().length > 0) {
				runtime.ctx.editor.setText(`/${command.name} ${subcommand.name} `);
				runtime.ctx.ui.requestRender();
				return;
			}
			// Dispatched as TEXT through this same function, so the picker runs exactly what typing
			// the subcommand runs. Resolving to a handler here would be a second implementation.
			void executeBuiltinSlashCommand(`/${command.name} ${subcommand.name}`, runtime);
		});
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
