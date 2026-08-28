import * as path from "node:path";
import { type AgentMessage, filterProviderReplayMessages } from "@veyyon/agent-core";
import type { Context, Message } from "@veyyon/ai";
import { errorMessage, logger } from "@veyyon/utils";
import type { ArgotSession } from "argot";
import { expandToolArguments } from "./argot-wire";
import type { Settings } from "./config/settings";
import type { ExtensionRunner } from "./extensibility/extensions";
import { type JsonWithOptionalFields, mapJsonStrings } from "./json-transform";
import {
	collectEnvSecrets,
	deobfuscateToolArguments,
	describeSecretRejection,
	loadSecrets,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "./secrets";
import { buildExpansionRecord, SecretAuditLog, secretAuditPath } from "./secrets/audit";
import { buildEnvSecretPattern, loadEnvSecretKeywords } from "./secrets/env-keywords";
import { SECRET_SPEND_NOTICE_SOURCE } from "./secrets/notices";
import { describeSecretExpiry } from "./secrets/obfuscator";
import { isSecretPlaceholder, PLACEHOLDER_RE } from "./secrets/placeholder";
import { expiryWarnings } from "./secrets/secret-command";
import { secretSpendMarker } from "./secrets/spend-marker";
import { resolveVaultLocations, type ScopedVaultEntry, SecretVault, vaultPathFor } from "./secrets/vault";
import { loadOrCreateVaultKey } from "./secrets/vault-crypto";
import { type AgentSession, obfuscateProviderPayload, type SecretRuntimeLease } from "./session/agent-session";
import { discoverAuthStorage } from "./session/auth-broker-config";
import { convertToLlm } from "./session/messages";
import type { OperatorNotices } from "./session/operator-notices";
import type { SessionManager } from "./session/session-manager";
import { wrapSteeringForModel } from "./session/steering-envelope";
import { BUILTIN_TOOLS, createTools, HIDDEN_TOOLS, type ToolSession } from "./tools";

export { type DialectFormat, resolveDialect } from "./config/dialect-format";
export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "./workspace-tree";

import { secretProtectionUnavailableMessage, type UnreadableVaultReport } from "./sdk-helpers";

export type { BuildSystemPromptOptions, CreateAgentSessionOptions, CreateAgentSessionResult } from "./sdk-helpers";
export {
	buildSystemPrompt,
	discoverContextFiles,
	discoverCustomTSCommands,
	discoverExtensions,
	discoverMCPServers,
	discoverPromptTemplates,
	discoverRules,
	discoverSessionExtensionPaths,
	discoverSkills,
	discoverSlashCommands,
	isInProcessChildSession,
	isSubagentSession,
	loadCliExtensionProviders,
	loadSessionExtensions,
} from "./sdk-helpers";

export { BUILTIN_TOOLS, createTools, discoverAuthStorage, HIDDEN_TOOLS, type ToolSession };

export class SecretRuntimeController {
	readonly #globalConfigRoot: string;
	readonly #agentDir: string;
	readonly #settings: Settings;
	readonly #operatorNotices: OperatorNotices;
	readonly #sessionManager: SessionManager;

	#obfuscator: SecretObfuscator | undefined;
	#redactionObfuscator: SecretObfuscator | undefined;
	#secretVault: SecretVault | undefined;
	#capturedVaultRevision: string | undefined;
	#secretAuditLog: SecretAuditLog | undefined;
	#secretRuntimeCwd: string;
	#latestSecretRuntimeRequest = 0;
	#pendingSecretRuntime: { revision: number; cwd: string; work: Promise<SecretRuntimeLease | undefined> } | undefined;
	#secretRuntimeLease: SecretRuntimeLease;
	#activeMainRequestRuntime: SecretRuntimeLease;
	#session?: AgentSession;

	readonly #auditLogBySecretLease = new WeakMap<object, SecretAuditLog | undefined>();
	readonly #vaultBySecretLease = new WeakMap<object, SecretVault>();
	readonly #secretRuntimeByObject = new WeakMap<object, SecretRuntimeLease>();

	constructor(params: {
		cwd: string;
		agentDir: string;
		globalConfigRoot: string;
		settings: Settings;
		operatorNotices: OperatorNotices;
		sessionManager: SessionManager;
		initialRuntime: {
			obfuscator?: SecretObfuscator;
			vault?: SecretVault;
			vaultRevision?: string;
			auditLog?: SecretAuditLog;
		};
	}) {
		this.#globalConfigRoot = params.globalConfigRoot;
		this.#agentDir = params.agentDir;
		this.#settings = params.settings;
		this.#operatorNotices = params.operatorNotices;
		this.#sessionManager = params.sessionManager;

		this.#obfuscator = params.initialRuntime.obfuscator;
		this.#redactionObfuscator = this.#obfuscator;
		this.#secretVault = params.initialRuntime.vault;
		this.#capturedVaultRevision = params.initialRuntime.vaultRevision;
		this.#secretAuditLog = params.initialRuntime.auditLog;
		this.#secretRuntimeCwd = path.resolve(params.cwd);

		this.#secretRuntimeLease = this.#createSecretRuntimeLease(
			0,
			params.cwd,
			this.#obfuscator,
			this.#redactionObfuscator,
			this.#secretVault,
			this.#capturedVaultRevision,
			this.#secretAuditLog,
		);
		this.#activeMainRequestRuntime = this.#secretRuntimeLease;
	}

	setSession(session: AgentSession): void {
		this.#session = session;
	}

	getLease(): SecretRuntimeLease {
		return this.#secretRuntimeLease;
	}

	getObfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	getRedactor(): SecretObfuscator | undefined {
		return this.#redactionObfuscator;
	}

	getVault(): SecretVault | undefined {
		return this.#secretVault;
	}

	getActiveMainRequestRuntime(): SecretRuntimeLease {
		return this.#activeMainRequestRuntime;
	}

	setActiveMainRequestRuntime(runtime: SecretRuntimeLease): void {
		this.#activeMainRequestRuntime = runtime;
	}

	async flushAuditLog(): Promise<void> {
		await this.#secretAuditLog?.flush();
	}

	bindSecretRuntime(value: unknown, runtime: SecretRuntimeLease): void {
		if (typeof value !== "object" || value === null) return;
		this.#secretRuntimeByObject.set(value, runtime);
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "object" && item !== null) this.#secretRuntimeByObject.set(item, runtime);
			}
		}
	}

	resolveSecretRuntimeForContext(context: Context): SecretRuntimeLease | undefined {
		const direct = this.#secretRuntimeByObject.get(context) ?? this.#secretRuntimeByObject.get(context.messages);
		if (direct) return direct;
		for (const message of context.messages) {
			const runtime = this.#secretRuntimeByObject.get(message);
			if (runtime) return runtime;
		}
		return undefined;
	}

	#scheduleStaleSecretRefresh(normalizedCwd: string): void {
		if (path.resolve(this.#sessionManager.getCwd()) !== normalizedCwd) return;
		if (this.#pendingSecretRuntime?.cwd === normalizedCwd) return;
		if (this.#secretRuntimeLease.cwd === normalizedCwd && this.#secretRuntimeLease.isFreshForExpansion()) return;
		void this.refreshSecretRuntime(normalizedCwd).catch(error => {
			logger.warn("Failed to refresh a stale secret runtime", {
				cwd: normalizedCwd,
				error: errorMessage(error),
			});
		});
	}

	#resolveFreshExpansionAuthority(requested: SecretRuntimeLease): SecretRuntimeLease | undefined {
		if (requested.isFreshForExpansion()) return requested;
		const live = this.#secretRuntimeLease;
		if (live === requested || live.cwd !== requested.cwd) return undefined;
		if (live.expansionObfuscator?.hasSecrets() !== true) return undefined;
		return live.isFreshForExpansion() ? live : undefined;
	}

	#unreadableVaultReport(requested: SecretRuntimeLease): UnreadableVaultReport | undefined {
		const live = this.#secretRuntimeLease;
		const authority = live.cwd === requested.cwd ? live : requested;
		const unreadable = this.#vaultBySecretLease.get(authority)?.unreadableScopes() ?? [];
		if (unreadable.length === 0) return undefined;
		const locations = resolveVaultLocations({
			globalConfigRoot: this.#globalConfigRoot,
			agentDir: this.#agentDir,
			cwd: authority.cwd,
		});
		const broken = unreadable.map(scope => `${scope} (${vaultPathFor(locations, scope)})`).join(", ");
		const commands = unreadable.map(scope => `/secret discard ${scope}`).join(" and ");
		return {
			authority,
			broken,
			repair: `Run ${commands} to move the unreadable file aside. Then store the secrets it held again.`,
		};
	}

	#assertNoOrphanPlaceholderWhileVaultUnreadable(requested: SecretRuntimeLease, args: Record<string, unknown>): void {
		const report = this.#unreadableVaultReport(requested);
		if (report === undefined) return;
		const scan = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
		let orphan: string | undefined;
		mapJsonStrings(args as JsonWithOptionalFields, text => {
			if (orphan !== undefined || !text.includes("#")) return text;
			scan.lastIndex = 0;
			for (;;) {
				const match = scan.exec(text);
				if (match === null) break;
				const token = match[0];
				if (isSecretPlaceholder(token) && report.authority.expansionObfuscator?.knowsPlaceholder(token) !== true) {
					orphan = token;
					break;
				}
			}
			return text;
		});
		if (orphan === undefined) return;
		throw new Error(
			`Secret expansion was refused because ${orphan} does not resolve and the vault could not be read, so there is no way to tell whether it is a credential this session should have expanded. Unreadable: ${report.broken}. ${report.repair} Nothing was run.`,
		);
	}

	#createSecretRuntimeLease(
		revision: number,
		runtimeCwd: string,
		expansionObfuscator: SecretObfuscator | undefined,
		redactor: SecretObfuscator | undefined,
		vault: SecretVault | undefined,
		vaultRevision: string | undefined,
		auditLog: SecretAuditLog | undefined,
	): SecretRuntimeLease {
		const normalizedCwd = path.resolve(runtimeCwd);
		const settledForExpansion = (text: string | undefined): boolean => {
			if (!vault || vaultRevision === undefined) return true;
			if (text !== undefined && expansionObfuscator?.containsLivePlaceholder(text) !== true) return true;
			return vault.revision() === vaultRevision;
		};
		const lease: SecretRuntimeLease = Object.freeze({
			revision,
			cwd: normalizedCwd,
			expansionObfuscator,
			redactionObfuscator: redactor,
			hasRedactions: redactor?.hasSecrets() ?? false,
			obfuscateText: (text: string) => redactor?.obfuscate(text) ?? text,
			obfuscateMessages: (messages: Message[]) => (redactor ? obfuscateMessages(redactor, messages) : messages),
			obfuscateContext: (context: Context) => (redactor ? obfuscateProviderContext(redactor, context) : context),
			obfuscatePayload: (payload: unknown) => obfuscateProviderPayload(payload, redactor),
			isFreshForExpansion: (text?: string) => settledForExpansion(text),
			ensureFreshForExpansion: async (text?: string) => {
				if (settledForExpansion(text)) return;
				if (path.resolve(this.#sessionManager.getCwd()) !== normalizedCwd) {
					await this.#pendingSecretRuntime?.work.catch(() => undefined);
					if (settledForExpansion(text)) return;
					throw new Error(
						`Secret expansion was refused because the vault changed under a lease pinned to ${normalizedCwd}, a directory the session has already left, so that project's vault cannot be reloaded for it. Retry once the directory change has finished.`,
					);
				}
				let refreshed: SecretRuntimeLease | undefined;
				let reloadError: unknown;
				try {
					refreshed = await this.refreshSecretRuntime(normalizedCwd);
				} catch (error) {
					reloadError = error;
				}
				if (refreshed?.isFreshForExpansion(text) === true) return;
				if (settledForExpansion(text)) return;
				const detail = reloadError === undefined ? "" : ` Reload failed: ${errorMessage(reloadError)}.`;
				throw new Error(
					`Secret expansion was refused: reloading the secret vault for ${normalizedCwd} did not produce a runtime that can resolve this text's placeholders, so no current value is available.${detail} Check what is stored with /secret list, then retry.`,
				);
			},
			assertFreshForExpansion: (text?: string) => {
				if (settledForExpansion(text)) return;
				this.#scheduleStaleSecretRefresh(normalizedCwd);
				throw new Error(
					path.resolve(this.#sessionManager.getCwd()) === normalizedCwd
						? "Secret expansion was refused because the vault on disk no longer matches the snapshot this request is pinned to, so a placeholder could resolve to a value the vault has already replaced. A reload is under way; retry this call, and check what is stored with /secret list if it keeps failing."
						: `Secret expansion was refused because the vault changed under a lease pinned to ${normalizedCwd}, a directory the session has already left; the destination's own reload is the authority. Retry once the directory change has finished.`,
				);
			},
		});
		this.#auditLogBySecretLease.set(lease, auditLog);
		if (vault) this.#vaultBySecretLease.set(lease, vault);
		return lease;
	}

	async #loadSecretRuntime(
		runtimeCwd: string,
		runtimeSettings: Settings = this.#settings,
		onUnreadableVault: "degrade" | "throw" = "throw",
	) {
		if (!runtimeSettings.get("secrets.enabled")) {
			return {
				obfuscator: undefined,
				vault: undefined,
				auditLog: undefined,
				vaultRevision: undefined,
			};
		}
		const placeholderKeyResultPromise = logger
			.time("loadSecretPlaceholderKey", () => loadOrCreateVaultKey(this.#globalConfigRoot))
			.then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);

		const fileEntries = await logger.time("loadSecrets", loadSecrets, runtimeCwd, this.#agentDir);
		const envKeywords = await logger.time("loadEnvSecretKeywords", () =>
			loadEnvSecretKeywords({ cwd: runtimeCwd, agentDir: this.#agentDir }),
		);
		const envEntries = collectEnvSecrets(buildEnvSecretPattern(envKeywords));
		const vaultLocations = resolveVaultLocations({
			globalConfigRoot: this.#globalConfigRoot,
			agentDir: this.#agentDir,
			cwd: runtimeCwd,
		});
		const vault = new SecretVault(vaultLocations);
		const auditLog = runtimeSettings.get("secrets.auditLog")
			? new SecretAuditLog(secretAuditPath(vaultLocations), this.#operatorNotices)
			: undefined;

		let liveVaultEntries: ScopedVaultEntry[] = [];
		try {
			liveVaultEntries = await logger.time("loadVault", () => vault.load());
		} catch (error) {
			await vault.noteFailedLoad(error);
			if (onUnreadableVault === "throw") throw error;
		}
		const vaultEntries: SecretEntry[] = liveVaultEntries.map(secret => ({
			type: "plain",
			content: secret.value,
			name: secret.name,
			expiresAt: secret.expiresAt,
			origin: "vault",
		}));

		const warnAboutExpiry = runtimeSettings.get("secrets.expiryWarnings");
		if (warnAboutExpiry) {
			for (const warning of expiryWarnings(liveVaultEntries, Date.now())) {
				this.#operatorNotices.warn("secrets", warning);
			}
		}

		const placeholderKeyResult = await placeholderKeyResultPromise;
		if (!placeholderKeyResult.ok) {
			throw new Error(secretProtectionUnavailableMessage(this.#globalConfigRoot), {
				cause: placeholderKeyResult.error,
			});
		}
		const placeholderKey = placeholderKeyResult.value;
		const vaultRevision = vault.revision();
		const nextObfuscator = new SecretObfuscator(envEntries.concat(fileEntries, vaultEntries), {
			placeholderKey,
			onRejection: rejection => this.#operatorNotices.warn("secrets", describeSecretRejection(rejection)),
			onExpiry: warnAboutExpiry
				? expiry => this.#operatorNotices.warn("secrets", describeSecretExpiry(expiry))
				: undefined,
		});
		return { obfuscator: nextObfuscator, vault, vaultRevision, auditLog };
	}

	async leaseSecretRuntime(): Promise<SecretRuntimeLease> {
		for (;;) {
			const pending = this.#pendingSecretRuntime;
			if (pending) {
				await pending.work;
				if (this.#pendingSecretRuntime !== pending) continue;
			}
			if (
				this.#secretVault &&
				this.#capturedVaultRevision !== undefined &&
				this.#secretVault.revision() !== this.#capturedVaultRevision
			) {
				return await this.refreshSecretRuntime(this.#sessionManager.getCwd());
			}
			return this.#secretRuntimeLease;
		}
	}

	refreshSecretRuntime = (runtimeCwd: string): Promise<SecretRuntimeLease> => {
		const revision = ++this.#latestSecretRuntimeRequest;
		const normalizedRuntimeCwd = path.resolve(runtimeCwd);
		const work = (async (): Promise<SecretRuntimeLease | undefined> => {
			const runtimeSettings =
				normalizedRuntimeCwd === this.#secretRuntimeCwd ||
				path.resolve(this.#settings.getCwd()) === normalizedRuntimeCwd
					? this.#settings
					: await this.#settings.cloneForCwd(normalizedRuntimeCwd);
			const next = await this.#loadSecretRuntime(normalizedRuntimeCwd, runtimeSettings);

			const isAuthoritative = (): boolean =>
				revision === this.#latestSecretRuntimeRequest &&
				path.resolve(this.#sessionManager.getCwd()) === normalizedRuntimeCwd;
			if (!isAuthoritative()) return undefined;

			if (next.obfuscator && this.#redactionObfuscator) {
				next.obfuscator.retainRedactionsFrom(this.#redactionObfuscator);
			} else if (this.#redactionObfuscator) {
				this.#redactionObfuscator.markAllPlaceholdersRetired();
			}
			await this.#secretAuditLog?.flush();
			if (!isAuthoritative()) return undefined;

			const nextRedactor = next.obfuscator ?? this.#redactionObfuscator;
			const nextLease = this.#createSecretRuntimeLease(
				revision,
				normalizedRuntimeCwd,
				next.obfuscator,
				nextRedactor,
				next.vault,
				next.vaultRevision,
				next.auditLog,
			);

			this.#obfuscator = next.obfuscator;
			this.#redactionObfuscator = nextRedactor;
			this.#secretVault = next.vault;
			this.#capturedVaultRevision = next.vaultRevision;
			this.#secretAuditLog = next.auditLog;
			this.#secretRuntimeCwd = normalizedRuntimeCwd;
			this.#secretRuntimeLease = nextLease;
			if (this.#session) this.#session.installSecretRuntime(nextLease);
			return nextLease;
		})();
		const pending = { revision, cwd: normalizedRuntimeCwd, work };
		this.#pendingSecretRuntime = pending;

		return (async () => {
			try {
				const committed = await work;
				if (committed) return committed;
				if (this.#pendingSecretRuntime === pending) this.#pendingSecretRuntime = undefined;
				return await this.leaseSecretRuntime();
			} catch (error) {
				if (revision !== this.#latestSecretRuntimeRequest) return await this.leaseSecretRuntime();
				throw error;
			} finally {
				if (this.#pendingSecretRuntime === pending) this.#pendingSecretRuntime = undefined;
			}
		})();
	};

	transformToolCallArguments(
		args: Record<string, unknown>,
		toolName: string,
		argot: ArgotSession | undefined,
		sessionId: string,
		emitNotice?: (level: "info" | "warning" | "error", message: string, source?: string) => void,
	): { execution: Record<string, unknown>; display: Record<string, unknown> } {
		let display = args;
		const maxTimeout = this.#settings.get("tools.maxTimeout");
		if (maxTimeout > 0 && typeof display.timeout === "number") {
			display = {
				...display,
				timeout: Math.min(display.timeout, maxTimeout),
			};
		}
		let execution = display;
		const requestRuntime = this.#activeMainRequestRuntime;
		const requestObfuscator = requestRuntime.expansionObfuscator;
		if (requestObfuscator === undefined && requestRuntime.redactionObfuscator) {
			mapJsonStrings(display as JsonWithOptionalFields, text => {
				requestRuntime.redactionObfuscator?.assertNoRetiredPlaceholder(text);
				return text;
			});
		}
		this.#assertNoOrphanPlaceholderWhileVaultUnreadable(requestRuntime, display);
		if (requestObfuscator?.hasSecrets()) {
			let expansionLease = requestRuntime;
			let expansionObfuscator = requestObfuscator;
			let carries = false;
			mapJsonStrings(display as JsonWithOptionalFields, text => {
				if (!carries && requestObfuscator.containsLivePlaceholder(text)) carries = true;
				return text;
			});
			if (!requestRuntime.isFreshForExpansion() && carries) {
				const fresh = this.#resolveFreshExpansionAuthority(requestRuntime);
				if (fresh === undefined) {
					requestRuntime.assertFreshForExpansion();
				} else {
					expansionLease = fresh;
					expansionObfuscator = fresh.expansionObfuscator ?? requestObfuscator;
				}
			}
			const requestAuditLog = this.#auditLogBySecretLease.get(expansionLease);
			if (requestAuditLog !== undefined) {
				const record = buildExpansionRecord({
					args: display,
					tool: toolName,
					session: sessionId,
					at: Date.now(),
					known: placeholder => expansionObfuscator.knowsPlaceholder(placeholder),
					obfuscate: value => requestRuntime.obfuscateText(value),
				});
				if (record !== null) requestAuditLog.record(record);
			}
			const spend = secretSpendMarker(display, toolName, placeholder =>
				expansionObfuscator.knowsPlaceholder(placeholder),
			);
			if (spend !== undefined) emitNotice?.("info", spend, SECRET_SPEND_NOTICE_SOURCE);
			execution = deobfuscateToolArguments(expansionObfuscator, display);
		}
		if (argot?.loaded) {
			const expandedDisplay = expandToolArguments(argot, display);
			execution = execution === display ? expandedDisplay : expandToolArguments(argot, execution);
			display = expandedDisplay;
		}
		return { execution, display };
	}

	async transformContext(messages: AgentMessage[], extensionRunner: ExtensionRunner): Promise<AgentMessage[]> {
		const runtime = await this.leaseSecretRuntime();
		this.#activeMainRequestRuntime = runtime;
		this.bindSecretRuntime(messages, runtime);
		const withContext = await extensionRunner.emitContext(messages);
		const transformed = wrapSteeringForModel(withContext);
		this.bindSecretRuntime(withContext, runtime);
		this.bindSecretRuntime(transformed, runtime);
		return transformed;
	}

	convertToLlmFinal(messages: AgentMessage[]): Message[] {
		const runtime = this.#secretRuntimeByObject.get(messages) ?? this.#activeMainRequestRuntime;
		const converted = filterProviderReplayMessages(convertToLlm(messages));
		const redacted = runtime.obfuscateMessages(converted);
		this.bindSecretRuntime(converted, runtime);
		this.bindSecretRuntime(redacted, runtime);
		return redacted;
	}

	async transformProviderContext(context: Context, requestRuntime?: SecretRuntimeLease): Promise<Context> {
		const runtime = requestRuntime ?? this.resolveSecretRuntimeForContext(context) ?? this.#activeMainRequestRuntime;
		const transformed = runtime.obfuscateContext(context);
		this.bindSecretRuntime(context, runtime);
		this.bindSecretRuntime(transformed, runtime);
		this.bindSecretRuntime(transformed.messages, runtime);
		return transformed;
	}
}

export { createAgentSession } from "./sdk-post-helpers";
