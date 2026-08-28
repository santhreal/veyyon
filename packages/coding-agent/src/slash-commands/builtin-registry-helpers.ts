import { getOAuthProviders, type OAuthProviderInfo } from "@veyyon/ai/oauth";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { stripEffortTierSuffix } from "@veyyon/catalog/variant-collapse";
import { type AutocompleteItem, Spacer } from "@veyyon/tui";
import { APP_NAME, collapseWhitespace, logger, nearestNames, truncate } from "@veyyon/utils";
import type { CollabHost } from "../collab/host";
import { credentialRemedySentence } from "../config/missing-credentials";
import {
	getModelMatchPreferences,
	resolveConfiguredModelPatterns,
	resolveModelFromString,
} from "../config/model-resolver";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import type { Settings } from "../config/settings";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import {
	type AccountRow,
	accountDisplayLabel,
	accountsForProvider,
	activeSessionAccounts,
	applyCredentialHealth,
	applyUsageReports,
	loadAccountInventory,
} from "../session/account-inventory";
import type { AgentSession, FreshSessionResult } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import type { ShakeMode } from "../session/shake-types";
import { configuredThinkingLevelsForModel } from "../thinking";
import { normalizeApprovalMode } from "../tools/approval";
import { AUTONOMY_LABEL, isKnownApprovalMode } from "../tools/approval-modes";
import { urlHyperlinkAlways } from "../tui";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
	type BuiltinSlashCommandName,
} from "./builtin-declarations";
import { type AccountRoleSources, accountRoleAnnotations, renderAccountStatus } from "./helpers/account-status";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { formatProviderName } from "./helpers/format";
import { commandConsumed, errorMessage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

export function refreshStatusLine(ctx: Pick<InteractiveModeContext, "statusLine" | "ui">): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/** `/fast status` label for the active model: "on" when its family is the priority tier, else "off". */
export function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** `/yolo status` label: "on" when the full permission bypass is active, else "off". */
export function formatYoloStatus(session: AgentSession): string {
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
export function describeApprovalMode(from: Settings, session?: AgentSession): string {
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
export function applyPermissionsCommand(
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
export function formatThinkingLevelChoices(session: AgentSession): string {
	return configuredThinkingLevelsForModel(session.model).join(", ");
}

/**
 * Why `/effort` has nothing to set on this model, naming the cause. A row
 * whose effort is baked into its id (`gpt-5.4-high`) names the baked tier and
 * points at the base id, where the control lives.
 */
export function noThinkingControlMessage(session: AgentSession): string {
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

export const AUTOCOMPLETE_DETAIL_LIMIT = 48;

export function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	return truncate(collapseWhitespace(value), limit);
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

/** Scheme-less display form of a browser deep link: accent + underline, OSC-8 linked to the full URL. */
export function collabWebLinkClickable(webLink: string): string {
	const display = theme.fg("accent", `\x1b[4m${webLink.replace(/^https?:\/\//, "")}\x1b[24m`);
	return urlHyperlinkAlways(webLink, display);
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
export function collabLinkHint(host: CollabHost, heading: string, view = false): string {
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

export function showCollabQrCode(ctx: Pick<InteractiveModeContext, "present" | "showError">, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(`Failed to render collab QR code: ${errorMessage(err)}`);
	}
}

export function showCollabLink(
	ctx: Pick<InteractiveModeContext, "present" | "showError" | "showStatus">,
	host: CollabHost,
	heading: string,
	view = false,
): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

export function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return `Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`;
}

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

export async function handleUsageResetCommand(
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
export function parseShakeMode(args: string): ShakeMode | { error: string } {
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
export const ACCOUNT_VERBS: readonly string[] = BUILTIN_SLASH_COMMAND_DECLARATIONS.flatMap(
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
export function accountRoleSources(session: AgentSession): AccountRoleSources {
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
export async function buildAccountStatusText(session: AgentSession): Promise<string> {
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
export function accountHealthLabel(row: AccountRow | undefined): string {
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
export async function refreshActiveAccounts(session: AgentSession): Promise<string> {
	const authStorage = session.modelRegistry.authStorage;
	const before = await loadAccountInventory(authStorage, { sessionId: session.sessionId });
	const routed = activeSessionAccounts(before);
	if (routed.length === 0) {
		return "No provider has routed a request in this session yet, so there is nothing to re-probe. /providers to probe a stored account.";
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
 *
 * Only a row that has ACTUALLY routed is a target. A persisted card choice is not: it survives
 * every restart and every profile, so falling back to it would silently name an account this
 * session never spent, on the strength of a decision made in some other session.
 */
export async function renameActiveAccount(
	session: AgentSession,
	text: string,
): Promise<{ ok: boolean; message: string }> {
	const provider = session.model?.provider;
	if (!provider) {
		return { ok: false, message: "No model is active, so no account is routed. Pick one with /model first." };
	}
	const inventory = await loadAccountInventory(session.modelRegistry.authStorage, { sessionId: session.sessionId });
	// Through the routed-accounts owner, not a second hand-rolled predicate: `activeForSession`
	// alone is true for a PREDICTED row too, so finding it here named an account this session had
	// never spent, on a provider whose traffic had not started.
	const row = activeSessionAccounts(inventory).find(entry => entry.provider === provider);
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
export async function credentialedProviderIds(session: AgentSession): Promise<string[]> {
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
export async function useProviderAccount(
	session: AgentSession,
	args: string,
): Promise<{ ok: boolean; message: string }> {
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
export function foldProviderKey(value: string): string {
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
export function findOAuthProvider(requested: string): OAuthProviderInfo | undefined {
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
export function looksLikeOAuthCallback(text: string): boolean {
	return text.includes("://") || text.includes("code=") || text.startsWith("?");
}

/**
 * Any provider in the registry, resolved the same folded way as an OAuth provider.
 *
 * Naming a provider that plainly exists is what separates "this one does not do browser logins" and
 * "you have nothing stored for it" from "we do not know that name", and those three need three
 * different next steps.
 */
export function findRegistryProvider(requested: string): { id: string; login?: unknown } | undefined {
	const wanted = foldProviderKey(requested);
	if (!wanted) return undefined;
	return PROVIDER_REGISTRY.find(
		provider => foldProviderKey(provider.id) === wanted || foldProviderKey(provider.name) === wanted,
	);
}

/** A provider that exists and signs in with an API key rather than a browser. */
export function findApiKeyProvider(requested: string): { id: string } | undefined {
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
export function providerSuggestionSentence(requested: string, command: "login" | "logout"): string {
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
export function loginTargetRefusal(requested: string): string {
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
export function logoutTargetRefusal(requested: string): string {
	const provider = findRegistryProvider(requested);
	if (provider) {
		return `No stored login for ${formatProviderName(provider.id)} to remove. If it is still serving requests, its credential comes from the environment or the models config, where veyyon cannot delete it for you.`;
	}
	return `Unknown provider "${truncate(requested, 40)}". ${providerSuggestionSentence(requested, "logout")}`;
}

/**
 * The provider a `/logout <text>` should open, or `undefined` when nothing stored answers to it.
 *
 * An OAuth provider always resolves, so `/logout anthropic` reaches `showLogout`, which states the
 * refusal naming where that provider's auth actually comes from. Beyond that, ANY provider holding a
 * stored credential resolves, because the account card lists those rows and deletes them with `x`: a
 * groq api_key row is visibly removable there, and `/logout groq` refusing it was the command
 * contradicting the card.
 */
export function findLogoutProvider(requested: string, authStorage: AuthStorage): string | undefined {
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
export function startProviderLogin(rawArgs: string, runtime: TuiSlashCommandRuntime): void {
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
			void runtime.ctx.showLogin(matchedProvider.id);
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

	void runtime.ctx.showLogin();
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
export type DeclarationNamed<Name extends BuiltinSlashCommandName> = Extract<
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
export type HandlerSetFor<Name extends BuiltinSlashCommandName> =
	DeclarationNamed<Name> extends { readonly textMode: true }
		? Required<Pick<SlashCommandSpec, "handle">> &
				Pick<SlashCommandSpec, "handleTui" | "getTuiAutocompleteDescription">
		: Pick<SlashCommandSpec, "handleTui" | "getTuiAutocompleteDescription"> & { readonly handle?: never };
