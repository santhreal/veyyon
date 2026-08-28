import {
	type Api,
	type CompletionProbe,
	type CompletionProbeInput,
	type CredentialCompletionResult,
	completeSimple,
	type Model,
} from "@veyyon/ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, type SnapshotResponse } from "@veyyon/ai/auth-broker";
import { DEFAULT_AUTH_GATEWAY_BIND, startAuthGateway } from "@veyyon/ai/auth-gateway";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { errorMessage, formatCount, VERSION } from "@veyyon/utils";
import chalk from "chalk";
import { type AuthBrokerClientConfig, resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { scopedTimeoutSignal } from "../utils/fetch-timeout";
import { AuthTokenFile, printToken } from "./auth-token-file";

export type AuthGatewayAction = "serve" | "token" | "status" | "check";

export interface AuthGatewayCommandArgs {
	action: AuthGatewayAction;
	flags: {
		json?: boolean;
		bind?: string;
		regenerate?: boolean;
		noAuth?: boolean;
		strict?: boolean;
	};
}

const ACTIONS: readonly AuthGatewayAction[] = ["serve", "token", "status", "check"];

const TOKEN_FILE = new AuthTokenFile("auth-gateway.token");

function createBrokerClient(brokerConfig: AuthBrokerClientConfig): AuthBrokerClient {
	return new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
}

async function fetchBrokerSnapshot(client: AuthBrokerClient): Promise<SnapshotResponse> {
	const result = await client.fetchSnapshot();
	if (result.status !== 200) throw new Error("Auth broker returned no initial snapshot");
	return result.snapshot;
}

async function runServe(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"`veyyon auth-gateway serve` requires VEYYON_AUTH_BROKER_URL (or `auth.broker.url`/`auth.broker.token` in config.yml). The gateway is itself a broker client.",
		);
	}
	const bind = flags.bind ?? DEFAULT_AUTH_GATEWAY_BIND;
	const gatewayToken = flags.noAuth ? null : await TOKEN_FILE.ensure();

	const client = createBrokerClient(brokerConfig);
	const initialSnapshot = await fetchBrokerSnapshot(client);
	const store = new RemoteAuthCredentialStore({ client, initialSnapshot });
	const storage = new AuthStorage(store, {
		sourceLabel: `broker ${brokerConfig.url}`,
	});
	await storage.reload();

	const snapshot = storage.exportSnapshot();
	const providersWithCreds = new Set<string>();
	for (const entry of snapshot.credentials) providersWithCreds.add(entry.provider);
	const modelById = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		if (!providersWithCreds.has(provider)) continue;
		for (const model of getBundledModels(provider as GeneratedProvider)) {
			modelById.set(`${model.provider}/${model.id}`, model);
			if (!modelById.has(model.id)) modelById.set(model.id, model);
		}
	}

	const handle = startAuthGateway({
		storage,
		bind,
		bearerTokens: gatewayToken ? [gatewayToken] : [],
		version: VERSION,
		resolveModel: (id: string) => modelById.get(id),
		listModels: () => modelById.values(),
	});
	process.stdout.write(`auth-gateway listening on ${handle.url}\n`);
	if (gatewayToken) {
		process.stdout.write(`bearer token: ${TOKEN_FILE.path()} (chmod 0600)\n`);
	} else {
		process.stdout.write(`auth: disabled (--no-auth) — any client can call this gateway\n`);
	}
	process.stdout.write(`upstream broker: ${brokerConfig.url}\n`);

	const stopped = Promise.withResolvers<void>();
	let shutdownStarted = false;
	const stop = async (signal: NodeJS.Signals): Promise<void> => {
		if (shutdownStarted) return;
		shutdownStarted = true;
		process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
		let closeError: unknown;
		try {
			await handle.close();
		} catch (error) {
			closeError = error;
		} finally {
			storage.close();
		}
		if (closeError) {
			stopped.reject(closeError);
		} else {
			stopped.resolve();
		}
	};
	const onSigint = (): void => {
		void stop("SIGINT");
	};
	const onSigterm = (): void => {
		void stop("SIGTERM");
	};
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	try {
		await stopped.promise;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

async function runStatus(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const token = await TOKEN_FILE.read();
	const brokerConfig = await resolveAuthBrokerConfig();
	const tokenFile = TOKEN_FILE.path();
	if (!brokerConfig) {
		const status = {
			ready: false,
			reason: "not_configured",
			tokenFile,
			tokenPresent: token !== null,
			broker: null,
			brokerConfigured: false,
			brokerAuthenticated: false,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			process.stdout.write(`${chalk.yellow("No broker configured.")} Set VEYYON_AUTH_BROKER_URL.\n`);
			process.stdout.write(
				`token: ${status.tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
		}
		process.exitCode = 1;
		return;
	}

	try {
		const snapshot = await fetchBrokerSnapshot(createBrokerClient(brokerConfig));
		const tokenPresent = token !== null;
		const status = {
			ready: tokenPresent,
			reason: tokenPresent ? null : "token_missing",
			tokenFile,
			tokenPresent,
			broker: brokerConfig.url,
			brokerConfigured: true,
			brokerAuthenticated: true,
			credentialCount: snapshot.credentials.length,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const brokerLine = `upstream broker: ${brokerConfig.url} (${formatCount("credential", snapshot.credentials.length)})`;
			process.stdout.write(`${tokenPresent ? chalk.green("ready") : chalk.yellow("not ready")} ${brokerLine}\n`);
			process.stdout.write(
				`token: ${tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
			if (!tokenPresent) {
				process.stdout.write(
					"Run `veyyon auth-gateway token` or `veyyon auth-gateway serve` to create a bearer token.\n",
				);
			}
		}
		if (!tokenPresent) process.exitCode = 1;
	} catch (error) {
		const message = errorMessage(error);
		const status = {
			ready: false,
			reason: "broker_unavailable",
			tokenFile,
			tokenPresent: token !== null,
			broker: brokerConfig.url,
			brokerConfigured: true,
			brokerAuthenticated: false,
			error: message,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			process.stdout.write(`${chalk.red("FAILED")} upstream broker: ${brokerConfig.url}: ${message}\n`);
			process.stdout.write(
				`token: ${status.tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
		}
		process.exitCode = 1;
	}
}

export async function runAuthGatewayCommand(cmd: AuthGatewayCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags);
			return;
		case "token":
			await printToken(TOKEN_FILE, cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "check":
			await runCheck(cmd.flags);
			return;
		default: {
			const _exhaustive: never = cmd.action;
			throw new Error(`Unknown auth-gateway action: ${String(_exhaustive)}`);
		}
	}
}

const STRUCTURED_API_KEY_PROVIDERS: ReadonlySet<string> = new Set([
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
]);

const STRICT_PROBE_SKIPPED_APIS: ReadonlySet<Api> = new Set<Api>([
	"bedrock-converse-stream",
	"google-vertex",
	"cursor-agent",
]);

const STRICT_PROBE_MAX_CANDIDATES = 4;

const STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS = 15_000;

const STRICT_PROBE_OVERALL_TIMEOUT_MS = STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS * (STRICT_PROBE_MAX_CANDIDATES + 1);

const RETRYABLE_MODEL_ERROR_RE =
	/not[_ -]found|invalid[_ -]model|model[_ -]is[_ -]not[_ -]valid|no longer supported|deprecated|404|decommissioned/i;

function pickProbeCandidates(provider: string): Model<Api>[] {
	const bundled = getBundledModels(provider as GeneratedProvider);
	if (bundled.length === 0) return [];
	const candidates = bundled.filter(model => {
		if (model.transport === "pi-native") return false;
		if (STRICT_PROBE_SKIPPED_APIS.has(model.api)) return false;
		if (!model.input.includes("text")) return false;
		const totalCost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
		if (!Number.isFinite(totalCost) || totalCost < 0) return false;
		if (model.maxTokens !== null && model.maxTokens <= 0) return false;
		return true;
	});
	candidates.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id));
	return candidates;
}

function composeProbeApiKey(provider: string, credential: CompletionProbeInput["credential"]): string {
	if (credential.type === "api_key") return credential.apiKey;
	if (!STRUCTURED_API_KEY_PROVIDERS.has(provider)) return credential.accessToken;
	return JSON.stringify({
		token: credential.accessToken,
		enterpriseUrl: credential.enterpriseUrl,
		projectId: credential.projectId,
		refreshToken: credential.refreshToken,
		expiresAt: credential.expiresAt,
		email: credential.email,
		accountId: credential.accountId,
	});
}

async function probeOneModel(
	model: Model<Api>,
	apiKey: string,
	outerSignal: AbortSignal,
): Promise<CredentialCompletionResult> {
	const start = Date.now();
	const attemptTimeout = scopedTimeoutSignal(STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS, outerSignal);
	let response: Awaited<ReturnType<typeof completeSimple>>;
	try {
		response = await completeSimple(
			model,
			{
				systemPrompt: ["Connectivity check. Reply with the single word 'pong'."],
				messages: [{ role: "user", content: "ping", timestamp: start }],
			},
			{
				apiKey,
				maxTokens: 32,
				signal: attemptTimeout.signal,
			},
		);
	} finally {
		attemptTimeout.cancel();
	}
	const latencyMs = Date.now() - start;
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return {
			ok: false,
			reason: response.errorMessage ?? `chat probe ended with stopReason=${response.stopReason}`,
			modelId: model.id,
			latencyMs,
		};
	}
	return { ok: true, modelId: model.id, latencyMs };
}

function createStrictCompletionProbe(): CompletionProbe {
	return async (input: CompletionProbeInput): Promise<CredentialCompletionResult> => {
		const candidates = pickProbeCandidates(input.provider).slice(0, STRICT_PROBE_MAX_CANDIDATES);
		if (candidates.length === 0) {
			return { ok: null, reason: `no bearer-compatible probe model bundled for provider ${input.provider}` };
		}
		const apiKey = composeProbeApiKey(input.provider, input.credential);
		let lastFailure: CredentialCompletionResult | undefined;
		for (const model of candidates) {
			if (input.signal.aborted) {
				return {
					ok: false,
					reason: "aborted",
					modelId: model.id,
				};
			}
			const result = await probeOneModel(model, apiKey, input.signal);
			if (result.ok === true) return result;
			lastFailure = result;
			if (!RETRYABLE_MODEL_ERROR_RE.test(result.reason ?? "")) {
				return result;
			}
		}
		return (
			lastFailure ?? {
				ok: false,
				reason: `all ${candidates.length} probe models failed for provider ${input.provider}`,
			}
		);
	};
}

function formatCompletionStatus(completion: CredentialCompletionResult | undefined): string {
	if (!completion) return "";
	if (completion.ok === true) return chalk.green(" [chat: ok]");
	if (completion.ok === false) return chalk.red(" [chat: FAIL]");
	return chalk.yellow(" [chat: skip]");
}

async function runCheck(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"`veyyon auth-gateway check` requires VEYYON_AUTH_BROKER_URL (or `auth.broker.url`/`auth.broker.token` in config.yml). It probes the same credentials the gateway would serve.",
		);
	}

	const client = createBrokerClient(brokerConfig);
	const initialSnapshot = await fetchBrokerSnapshot(client);
	const store = new RemoteAuthCredentialStore({ client, initialSnapshot });
	const storage = new AuthStorage(store, { sourceLabel: `broker ${brokerConfig.url}` });
	try {
		await storage.reload();
		const results = await storage.checkCredentials(
			flags.strict
				? { completionProbe: createStrictCompletionProbe(), completionTimeoutMs: STRICT_PROBE_OVERALL_TIMEOUT_MS }
				: undefined,
		);

		if (flags.json) {
			process.stdout.write(
				`${JSON.stringify({ broker: brokerConfig.url, strict: flags.strict === true, credentials: results }, null, 2)}\n`,
			);
		} else {
			const grouped = new Map<string, typeof results>();
			for (const row of results) {
				const list = grouped.get(row.provider) ?? [];
				list.push(row);
				grouped.set(row.provider, list);
			}
			const providers = Array.from(grouped.keys()).sort();
			process.stdout.write(`broker: ${brokerConfig.url}${flags.strict ? chalk.dim(" [strict]") : ""}\n`);
			for (const provider of providers) {
				const rows = grouped.get(provider) ?? [];
				process.stdout.write(`\n${chalk.bold(provider)} (${rows.length})\n`);
				for (const row of rows) {
					const status =
						row.ok === true
							? chalk.green("ok      ")
							: row.ok === false
								? chalk.red("FAIL    ")
								: chalk.yellow("unknown ");
					const base =
						row.email ?? row.accountId ?? (row.type === "api_key" ? "(api key)" : "(no identity on credential)");
					const org = row.orgName ?? row.orgId;
					const identity = org && org !== base ? `${base} (${org})` : base;
					const remote = row.remoteRefresh ? chalk.dim(" [remote-refresh]") : "";
					const reasonParts: string[] = [];
					if (row.reason) reasonParts.push(row.reason);
					if (row.completion?.reason) reasonParts.push(`chat: ${row.completion.reason}`);
					const reason = reasonParts.length > 0 ? chalk.dim(` — ${reasonParts.join("; ")}`) : "";
					const chat = formatCompletionStatus(row.completion);
					process.stdout.write(
						`  ${status}${chat} id=${row.id.toString().padStart(3)} ${row.type.padEnd(7)} ${identity}${remote}${reason}\n`,
					);
				}
			}
			const failed = results.filter(row => row.ok === false).length;
			const unverifiable = results.filter(row => row.ok === null).length;
			const passing = results.filter(row => row.ok === true).length;
			const chatFailed = flags.strict ? results.filter(row => row.completion?.ok === false).length : 0;
			const summaryParts = [
				chalk.green(`${passing} ok`),
				chalk.red(`${failed} failed`),
				chalk.yellow(`${unverifiable} unverifiable`),
			];
			if (flags.strict) summaryParts.push(chalk.red(`${chatFailed} chat-failed`));
			summaryParts.push(`${results.length} total`);
			process.stdout.write(`\n${summaryParts.join(", ")}\n`);
			if (failed > 0 || chatFailed > 0) process.exitCode = 1;
		}
	} finally {
		storage.close();
	}
}

export { ACTIONS as AUTH_GATEWAY_ACTIONS };
