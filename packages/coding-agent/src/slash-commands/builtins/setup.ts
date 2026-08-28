import { getOAuthProviders, type OAuthProviderInfo } from "@veyyon/ai/oauth";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { getAgentDir, getGlobalConfigRootDir, logger, nearestNames, truncate } from "@veyyon/utils";
import { runTrustSlashCommand } from "../../cli/trust-cli";
import { credentialRemedySentence } from "../../config/missing-credentials";
import {
	getModelMatchPreferences,
	resolveConfiguredModelPatterns,
	resolveModelFromString,
} from "../../config/model-resolver";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers.js";
import { PluginManager } from "../../extensibility/plugins";
import { loadConfig } from "../../lsp/config";
import { theme } from "../../modes/theme/theme";
import {
	type AccountRow,
	accountDisplayLabel,
	accountsForProvider,
	activeSessionAccounts,
	applyCredentialHealth,
	applyUsageReports,
	loadAccountInventory,
} from "../../session/account-inventory";
import type { AgentSession } from "../../session/agent-session";
import type { AuthStorage } from "../../session/auth-storage";
import { resolveVeyyonCommand } from "../../task/veyyon-command";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS, type BuiltinSlashCommandDeclaration } from "../builtin-declarations";
import { type AccountRoleSources, accountRoleAnnotations, renderAccountStatus } from "../helpers/account-status";
import { formatProviderName } from "../helpers/format";
import { handleMcpAcp } from "../helpers/mcp";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "../helpers/parse";
import { interactiveSecretPort, runSecretCommandForSurface } from "../helpers/secret";
import { handleSshAcp } from "../helpers/ssh";
import { buildUsageReportText } from "../helpers/usage-report";
import { type ProfileCommandPort, parseProfileCommand, runProfileSlashCommand } from "../profile-command";
import type { TuiSlashCommandRuntime } from "../types";
import type { HandlerSetFor } from "./types";

const ACCOUNT_VERBS: readonly string[] = BUILTIN_SLASH_COMMAND_DECLARATIONS.flatMap(
	(command: BuiltinSlashCommandDeclaration) =>
		command.name === "account" ? (command.subcommands ?? []).map(sub => sub.name) : [],
);

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

function accountHealthLabel(row: AccountRow | undefined): string {
	if (!row?.health) return "not probed";
	if (row.health === "ok") return "ok";
	if (row.health === "unverifiable") return "unverifiable from here";
	return `failed (${row.healthReason ?? "no reason reported"})`;
}

async function refreshActiveAccounts(session: AgentSession): Promise<string> {
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

async function renameActiveAccount(session: AgentSession, text: string): Promise<{ ok: boolean; message: string }> {
	const provider = session.model?.provider;
	if (!provider) {
		return { ok: false, message: "No model is active, so no account is routed. Pick one with /model first." };
	}
	const inventory = await loadAccountInventory(session.modelRegistry.authStorage, { sessionId: session.sessionId });

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

async function credentialedProviderIds(session: AgentSession): Promise<string[]> {
	const inventory = await loadAccountInventory(session.modelRegistry.authStorage, {
		sessionId: session.sessionId,
	});
	return inventory.providers.map(entry => entry.provider);
}

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

function foldProviderKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findOAuthProvider(requested: string): OAuthProviderInfo | undefined {
	const wanted = foldProviderKey(requested);
	if (!wanted) return undefined;
	const providers = getOAuthProviders();
	return (
		providers.find(provider => foldProviderKey(provider.id) === wanted) ??
		providers.find(provider => foldProviderKey(provider.name) === wanted)
	);
}

function looksLikeOAuthCallback(text: string): boolean {
	return text.includes("://") || text.includes("code=") || text.startsWith("?");
}

function findRegistryProvider(requested: string): { id: string; login?: unknown } | undefined {
	const wanted = foldProviderKey(requested);
	if (!wanted) return undefined;
	return PROVIDER_REGISTRY.find(
		provider => foldProviderKey(provider.id) === wanted || foldProviderKey(provider.name) === wanted,
	);
}

function findApiKeyProvider(requested: string): { id: string } | undefined {
	const provider = findRegistryProvider(requested);
	return provider && !provider.login ? provider : undefined;
}

function providerSuggestionSentence(requested: string, command: "login" | "logout"): string {
	const providers = getOAuthProviders();
	const candidates = providers.flatMap(provider => [provider.id, provider.name]);
	const near = nearestNames(requested, candidates, 3);
	const suggestion = near.length > 0 ? `Did you mean ${near.join(", ")}? ` : "";
	return `${suggestion}Run /${command} with no argument to pick from ${providers.length} providers you can sign in to.`;
}

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

function logoutTargetRefusal(requested: string): string {
	const provider = findRegistryProvider(requested);
	if (provider) {
		return `No stored login for ${formatProviderName(provider.id)} to remove. If it is still serving requests, its credential comes from the environment or the models config, where veyyon cannot delete it for you.`;
	}
	return `Unknown provider "${truncate(requested, 40)}". ${providerSuggestionSentence(requested, "logout")}`;
}

function findLogoutProvider(requested: string, authStorage: AuthStorage): string | undefined {
	const oauth = findOAuthProvider(requested);
	if (oauth) return oauth.id;
	const provider = findRegistryProvider(requested);
	if (provider && authStorage.listStoredCredentials(provider.id).length > 0) return provider.id;
	return undefined;
}

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
			void runtime.ctx.showLogin(matchedProvider.id);
			runtime.ctx.editor.setText("");
			return;
		}
		if (manualInput.hasPending()) {
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

export const SETUP_HANDLERS = {
	settings: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	statusline: {
		handleTui: (_command, runtime) => {
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
			if (verb === "use") {
				await runtime.output((await useProviderAccount(runtime.session, rest)).message);
				return commandConsumed();
			}
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
			if (verb === "login") {
				startProviderLogin(rest, runtime);
				return;
			}
			if (verb === "logout") {
				const requested = rest.trim();
				if (requested) {
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
	secret: {
		getTuiAutocompleteDescription: runtime => {
			const base = "Store a credential the agent can use without ever seeing it";
			const session = runtime.ctx.session;
			if (!session?.secretsEnabled) return `${base} · protection off, adding one turns it on`;
			const stored = session.obfuscator?.namedSecretNames().length ?? 0;
			if (stored === 0) return `${base} · protection on, none stored yet`;
			return `${base} · protection on, ${stored} stored`;
		},
		handle: async (command, runtime) => {
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
	profile: {
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
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
	extensions: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
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
			runtime.ctx.showStatus(report);
		},
	},
} satisfies {
	settings: HandlerSetFor<"settings">;
	secret: HandlerSetFor<"secret">;
	statusline: HandlerSetFor<"statusline">;
	welcome: HandlerSetFor<"welcome">;
	lsp: HandlerSetFor<"lsp">;
	setup: HandlerSetFor<"setup">;
	providers: HandlerSetFor<"providers">;
	account: HandlerSetFor<"account">;
	login: HandlerSetFor<"login">;
	logout: HandlerSetFor<"logout">;
	profile: HandlerSetFor<"profile">;
	mcp: HandlerSetFor<"mcp">;
	ssh: HandlerSetFor<"ssh">;
	extensions: HandlerSetFor<"extensions">;
	plugins: HandlerSetFor<"plugins">;
	"reload-plugins": HandlerSetFor<"reload-plugins">;
	trust: HandlerSetFor<"trust">;
};
