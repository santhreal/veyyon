import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { getOAuthProviders, type OAuthProviderInfo } from "@veyyon/ai/oauth";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { getAgentDir, getGlobalConfigRootDir, logger, nearestNames, truncate } from "@veyyon/utils";
import { runTrustSlashCommand } from "../cli/trust-cli";
import { credentialRemedySentence } from "../config/missing-credentials";
import {
	getModelMatchPreferences,
	resolveConfiguredModelPatterns,
	resolveModelFromString,
} from "../config/model-resolver";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers.js";
import { PluginManager } from "../extensibility/plugins";
import { formatProviderName } from "../session/account-format";
import {
	type AccountRow,
	accountDisplayLabel,
	accountsForProvider,
	activeSessionAccounts,
	applyCredentialHealth,
	applyUsageReports,
	loadAccountInventory,
} from "../session/account-inventory";
import type { AgentSession } from "../session/agent-session";
import { configuredAgentModelChains } from "../task/agent-settings";
import { theme } from "../theme/theme";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS, type BuiltinSlashCommandDeclaration } from "./builtin-declarations";
import type { BuiltinSlashCommandHandlers } from "./handler-types";
import {
	ACCOUNT_STATUS_TITLE,
	type AccountRoleSources,
	type AccountStatusStyle,
	accountRoleAnnotations,
	renderAccountStatus,
} from "./helpers/account-status";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { interactiveSecretPort, runSecretCommandForSurface } from "./helpers/secret";
import { handleSshAcp } from "./helpers/ssh";
import { buildUsageReportText } from "./helpers/usage-report";
import type { ProfileCommandPort } from "./profile-command";
import type { TuiSlashCommandHostContext, TuiSlashCommandRuntime } from "./types";

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
 * looking at, the models spawned agents run on, and the web-search backend. They are read from the
 * settings the runtime itself obeys, so the block cannot claim a role the router does not honor.
 *
 * Spawned agents are a UNION of every chain a spawn can land on: the default model role, the shared
 * chain, and every lane that names a model of its own. Both scopes are read, because the scope
 * switch is one keystroke and re-annotating providers on it would make the badges flicker.
 * Nothing resolvable at all falls back to the main provider, which is what a spawn reaches when
 * the default role is unset.
 */
export function accountRoleSources(session: AgentSession): AccountRoleSources {
	const model = session.model;
	const available = session.modelRegistry.getAvailable();
	const preferences = getModelMatchPreferences(session.settings);
	const agentProviders: string[] = [];
	for (const chain of configuredAgentModelChains(session.settings)) {
		for (const pattern of resolveConfiguredModelPatterns(chain, session.settings)) {
			const resolved = resolveModelFromString(pattern, available, preferences);
			if (resolved && !agentProviders.includes(resolved.provider)) agentProviders.push(resolved.provider);
		}
	}
	if (agentProviders.length === 0 && model) agentProviders.push(model.provider);
	const webSearch = session.settings.get("providers.webSearch");
	return {
		...(model ? { mainModel: { provider: model.provider, id: model.id } } : {}),
		agentProviders,
		...(typeof webSearch === "string" ? { webSearchPreference: webSearch } : {}),
	};
}

/** The TUI's colours for the `/account status` block; a text client passes none. */
export const ACCOUNT_STATUS_TUI_STYLE: AccountStatusStyle = {
	title: text => text,
	name: text => theme.bold(text),
	muted: text => theme.fg("dim", text),
	warn: text => theme.fg("warning", text),
	command: text => theme.fg("accent", text),
};

/**
 * The `/account status` block for a session: routing read from disk, usage from the provider.
 *
 * Usage comes through the same `session.fetchUsageReports()` that `/usage` calls, so the two
 * surfaces cannot disagree about a percentage. A failed fetch degrades to the routing-only block
 * rather than failing the command: which account is serving is on disk and still worth printing.
 *
 * Returns the block's lines; line one is the title. A text client prints them as they are, the TUI
 * lifts the title into a transcript block header (see {@link presentAccountStatus}).
 */
export async function buildAccountStatusLines(session: AgentSession, style?: AccountStatusStyle): Promise<string[]> {
	let inventory = await loadAccountInventory(session.modelRegistry.authStorage, { sessionId: session.sessionId });
	try {
		const reports = await session.fetchUsageReports();
		if (reports && reports.length > 0) inventory = applyUsageReports(inventory, reports);
	} catch (error) {
		logger.debug("account status: usage fetch failed", { error: errorMessage(error) });
	}
	return renderAccountStatus(inventory, Date.now(), accountRoleAnnotations(accountRoleSources(session)), style);
}

/**
 * The TUI form of `/account status`: a transcript block with the title as its header, not a
 * paragraph printed as though the assistant had said it.
 */
export async function presentAccountStatus(
	ctx: Pick<TuiSlashCommandHostContext, "showReport" | "session">,
): Promise<void> {
	const lines = await buildAccountStatusLines(ctx.session, ACCOUNT_STATUS_TUI_STYLE);
	// Line one is the title and line two the blank under it; the header row carries both.
	ctx.showReport(ACCOUNT_STATUS_TITLE, lines.slice(2).join("\n"));
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

/** What the setup builtins DO, keyed by the name each is declared under. */
export const SETUP_HANDLERS = {
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
						theme.fg("dim", "Detected for this project but not installed:"),
						...missing.map(
							server =>
								`${theme.fg("warning", theme.status.pending)} ${server.name} ${theme.fg("dim", `(needs \`${server.command}\` on $PATH · ${server.fileTypes.join(", ")})`)}`,
						),
					];
					runtime.ctx.showReport("Language Servers", lines.join("\n"));
				} else {
					runtime.ctx.showReport(
						"Language Servers",
						theme.fg("dim", "No language servers configured for this project."),
					);
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
				runtime.ctx.showReport("Language Servers", lines.join("\n"));
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
				await runtime.output((await buildAccountStatusLines(runtime.session)).join("\n"));
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
				await presentAccountStatus(runtime.ctx);
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
				runtime.ctx.showReport("Account Refresh", await refreshActiveAccounts(runtime.ctx.session));
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
					void runtime.ctx.showLogout(matched);
					return;
				}
				void runtime.ctx.showLogout();
				return;
			}
			runtime.ctx.showWarning(`Unknown /account subcommand "${verb}". Use ${ACCOUNT_VERBS.join(", ")}.`);
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
		 * Text and ACP: no terminal to hide anything on, so there is no prompt. `/secret from-env` is the
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
		 * The TUI, which CAN hide what is typed, so `/secret add` with nothing after it opens a masked
		 * field.
		 *
		 * THE EDITOR IS CLEARED BEFORE THE VALUE IS READ, not after. The line after `add` IS the
		 * credential, so leaving it in the input buffer would park a live token there for as long as the
		 * prompt is open, and a cancelled prompt would leave it there for good. The prompt is a local
		 * dialog, never raced against a collab guest, so a masked field cannot be answered from another
		 * machine.
		 */
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			try {
				const outcome = await runSecretCommandForSurface(command.args ?? "", interactiveSecretPort(ctx));
				if (!outcome.cancelled) ctx.showStatus(outcome.message);
			} catch (error) {
				ctx.showWarning(errorMessage(error));
			}
			return commandConsumed();
		},
	},
	extensions: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
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
				void runtime.ctx.showLogout(matched);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showLogout();
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
					runtime.ctx.showReport("Plugins", theme.fg("dim", "No plugins installed"));
					return;
				}
				const lines = [
					theme.fg("dim", "npm plugins:"),
					...npmPlugins.map(p => {
						const status = p.enabled === false ? " (disabled)" : "";
						return `  ${p.name}@${p.version}${status}`;
					}),
				];
				runtime.ctx.showReport("Plugins", lines.join("\n"));
			} catch (err) {
				runtime.ctx.showError(`Plugin error: ${errorMessage(err)}`);
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
	trust: {
		handle: async (command, runtime) => {
			await runtime.output(await runTrustSlashCommand(command.args, runtime.settings.getAgentDir(), runtime.cwd));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const report = await runTrustSlashCommand(
				command.args,
				runtime.ctx.settings.getAgentDir(),
				runtime.ctx.sessionManager.getCwd(),
			);
			runtime.ctx.showReport("Trust", report.trimEnd());
		},
	},
} satisfies Partial<BuiltinSlashCommandHandlers>;
