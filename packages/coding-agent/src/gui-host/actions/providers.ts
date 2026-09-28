import type { AuthStorage } from "@veyyon/ai";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";
import { errorMessage } from "@veyyon/utils";
import { formatProviderName } from "../../session/account-format";
import { accountDisplayLabel, buildAccountInventory } from "../../session/account-inventory";
import { openPath } from "../../utils/open";
import { actingSettings } from "../acting-settings";
import { writeFrame } from "../frames";
import type { ActiveAuthFlow } from "../turns";
import type { AuthFlowView, ProviderView, SnapshotSection } from "../wire";
import { publishModelsAfterAuthChange } from "./models";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

function buildProvidersView(authStorage: AuthStorage): ProviderView[] {
	const oauthProviders = getOAuthProviders();
	const oauthIds = new Set(oauthProviders.map(p => p.id));
	const seen = new Set<string>();
	const providers: ProviderView[] = [];

	for (const def of PROVIDER_REGISTRY) {
		if (seen.has(def.id)) continue;
		seen.add(def.id);
		const isOauth = oauthIds.has(def.id) || def.login !== undefined;
		providers.push({
			id: def.id,
			name: def.name,
			authenticated: authStorage.hasAuth(def.id),
			oauth: isOauth,
			api_key: true,
		});
	}

	for (const entry of CATALOG_PROVIDERS) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		providers.push({
			id: entry.id,
			name:
				"catalogDiscovery" in entry && entry.catalogDiscovery
					? entry.catalogDiscovery.label
					: formatProviderName(entry.id),
			authenticated: authStorage.hasAuth(entry.id),
			oauth: oauthIds.has(entry.id),
			api_key: true,
		});
	}

	return providers;
}

/**
 * The provider list and every stored account, as a window draws them after
 * any change to the credential store.
 *
 * The list leaves out the providers the `disabledProviders` setting names,
 * which is what the terminal's sign-in list does. The accounts are the rows
 * the terminal's account card lists, one per stored credential, labelled the
 * way the card labels them. Reads the store as it is held; a caller that
 * wants a login made by another process reloads it first.
 */
async function providerSections(ctx: ActionContext, authStorage: AuthStorage): Promise<SnapshotSection[]> {
	const disabled = new Set((await actingSettings(ctx)).get("disabledProviders"));
	const inventory = buildAccountInventory(authStorage);
	return [
		{ Providers: buildProvidersView(authStorage).filter(provider => !disabled.has(provider.id)) },
		{
			Accounts: inventory.providers.flatMap(entry =>
				entry.rows.map(row => ({
					provider: row.provider,
					credential_id: row.credentialId,
					label: accountDisplayLabel(row),
					kind: row.type,
					selected: row.selectedForProvider,
				})),
			),
		},
	];
}

const handleRefreshProviders: ActionHandler = async ctx => {
	try {
		const authStorage = await ctx.authStorage();
		// A login completed by another process is on disk and not in this one.
		await authStorage.reload();
		for (const section of await providerSections(ctx, authStorage)) ctx.reply.snapshot(section);
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Provider",
			code: "PROVIDER_REFRESH_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

interface StartProviderAuthPayload {
	provider?: string;
}

const handleStartProviderAuth: ActionHandler<StartProviderAuthPayload | undefined> = async (ctx, payload) => {
	if (!payload?.provider) {
		ctx.reply.failure({
			scope: "Authentication",
			code: "INVALID_ARGUMENTS",
			message: "StartProviderAuth requires a provider parameter",
			retryable: false,
		});
		return;
	}

	const providerId = payload.provider;
	const oauthProvider =
		getOAuthProviders().find(p => p.id === providerId) ??
		PROVIDER_REGISTRY.find(p => p.id === providerId && p.login !== undefined);

	if (!oauthProvider) {
		const flow: ActiveAuthFlow = {
			provider: providerId,
			state: "AwaitingSecret",
			url: null,
			prompt: `Enter API key for ${formatProviderName(providerId)}`,
			message: null,
			type: "api_key",
		};
		ctx.clientState.authFlow = flow;
		ctx.reply.snapshot({
			AuthFlow: {
				provider: flow.provider,
				state: flow.state,
				url: flow.url,
				prompt: flow.prompt,
				message: flow.message,
			},
		});
		ctx.reply.success();
		return;
	}

	const authStorage = await ctx.authStorage();
	const abortController = new AbortController();
	let currentUrl: string | null = null;

	const runFlow = () => {
		void (async () => {
			try {
				await authStorage.login(providerId as never, {
					signal: abortController.signal,
					onAuth: info => {
						currentUrl = info.url;
						const flowView: AuthFlowView = {
							provider: providerId,
							state: "AwaitingBrowser",
							url: info.url,
							prompt: null,
							message: info.instructions ?? null,
						};
						if (ctx.clientState.authFlow) {
							ctx.clientState.authFlow.state = "AwaitingBrowser";
							ctx.clientState.authFlow.url = info.url;
							ctx.clientState.authFlow.message = info.instructions ?? null;
						}
						writeFrame(ctx.socket, { Snapshot: { AuthFlow: flowView } });
					},
					onProgress: msg => {
						if (ctx.clientState.authFlow) {
							ctx.clientState.authFlow.message = msg;
						}
					},
					onPrompt: async prompt => {
						const { promise, resolve, reject } = Promise.withResolvers<string>();
						if (ctx.clientState.authFlow) {
							ctx.clientState.authFlow.state = "AwaitingSecret";
							ctx.clientState.authFlow.prompt = prompt.message;
							ctx.clientState.authFlow.secretResolver = resolve;
							ctx.clientState.authFlow.secretRejecter = reject;
						}
						const flowView: AuthFlowView = {
							provider: providerId,
							state: "AwaitingSecret",
							url: currentUrl,
							prompt: prompt.message,
							message: null,
						};
						writeFrame(ctx.socket, { Snapshot: { AuthFlow: flowView } });
						return promise;
					},
					// Device-code and paste flows get no browser redirect of their
					// own; the terminal opens the success page they serve, and so
					// does this host, on the machine the login runs on.
					onSuccessPage: url => {
						openPath(url);
					},
				});

				const completedView: AuthFlowView = {
					provider: providerId,
					state: "Completed",
					url: null,
					prompt: null,
					message: null,
				};
				if (ctx.clientState.authFlow) {
					ctx.clientState.authFlow.state = "Completed";
				}
				writeFrame(ctx.socket, { Snapshot: { AuthFlow: completedView } });

				for (const section of await providerSections(ctx, authStorage)) {
					writeFrame(ctx.socket, { Snapshot: section });
				}
				await publishModelsAfterAuthChange(ctx);
			} catch (err: unknown) {
				if (abortController.signal.aborted) {
					const cancelledView: AuthFlowView = {
						provider: providerId,
						state: "Cancelled",
						url: null,
						prompt: null,
						message: null,
					};
					if (ctx.clientState.authFlow) {
						ctx.clientState.authFlow.state = "Cancelled";
					}
					writeFrame(ctx.socket, { Snapshot: { AuthFlow: cancelledView } });
				} else {
					const failure = errorMessage(err);
					const failedView: AuthFlowView = {
						provider: providerId,
						state: "Failed",
						url: null,
						prompt: null,
						message: failure,
					};
					if (ctx.clientState.authFlow) {
						ctx.clientState.authFlow.state = "Failed";
						ctx.clientState.authFlow.message = failure;
					}
					writeFrame(ctx.socket, { Snapshot: { AuthFlow: failedView } });
				}
			}
		})();
	};

	ctx.clientState.authFlow = {
		provider: providerId,
		state: "AwaitingBrowser",
		url: null,
		prompt: null,
		message: null,
		type: "oauth",
		abortController,
		retry: runFlow,
	};
	runFlow();
	ctx.reply.success();
};

interface SubmitAuthSecretPayload {
	provider?: string;
	secret?: string;
}

const handleSubmitAuthSecret: ActionHandler<SubmitAuthSecretPayload | undefined> = async (ctx, payload) => {
	if (!payload?.provider || !payload?.secret) {
		ctx.reply.failure({
			scope: "Authentication",
			code: "INVALID_ARGUMENTS",
			message: "SubmitAuthSecret requires provider and secret parameters",
			retryable: false,
		});
		return;
	}

	if (ctx.clientState.authFlow?.provider === payload.provider && ctx.clientState.authFlow.secretResolver) {
		const resolver = ctx.clientState.authFlow.secretResolver;
		ctx.clientState.authFlow.secretResolver = undefined;
		resolver(payload.secret);
		ctx.reply.success();
		return;
	}

	try {
		const authStorage = await ctx.authStorage();
		await authStorage.set(payload.provider, { type: "api_key", key: payload.secret });
		if (ctx.clientState.authFlow?.provider === payload.provider) {
			ctx.clientState.authFlow.state = "Completed";
			ctx.reply.snapshot({
				AuthFlow: {
					provider: payload.provider,
					state: "Completed",
					url: null,
					prompt: null,
					message: null,
				},
			});
		}
		for (const section of await providerSections(ctx, authStorage)) ctx.reply.snapshot(section);
		await publishModelsAfterAuthChange(ctx);
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Authentication",
			code: "SET_API_KEY_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

interface OpenAuthUrlPayload {
	url?: string;
}

const handleOpenAuthUrl: ActionHandler<OpenAuthUrlPayload | undefined> = (ctx, payload) => {
	if (!payload?.url) {
		ctx.reply.failure({
			scope: "Authentication",
			code: "INVALID_ARGUMENTS",
			message: "OpenAuthUrl requires a url parameter",
			retryable: false,
		});
		return;
	}

	openPath(payload.url);
	ctx.reply.success();
};

interface CancelAuthFlowPayload {
	provider?: string;
}

const handleCancelAuthFlow: ActionHandler<CancelAuthFlowPayload | undefined> = (ctx, payload) => {
	if (!payload?.provider) {
		ctx.reply.failure({
			scope: "Authentication",
			code: "INVALID_ARGUMENTS",
			message: "CancelAuthFlow requires a provider parameter",
			retryable: false,
		});
		return;
	}

	if (ctx.clientState.authFlow?.provider === payload.provider) {
		ctx.clientState.authFlow.abortController?.abort();
		ctx.clientState.authFlow.secretRejecter?.(new Error("Auth flow cancelled"));
		ctx.clientState.authFlow.state = "Cancelled";
		ctx.reply.snapshot({
			AuthFlow: {
				provider: payload.provider,
				state: "Cancelled",
				url: null,
				prompt: null,
				message: null,
			},
		});
	}

	ctx.reply.success();
};

interface RetryAuthFlowPayload {
	provider?: string;
}

const handleRetryAuthFlow: ActionHandler<RetryAuthFlowPayload | undefined> = async (ctx, payload) => {
	if (!payload?.provider) {
		ctx.reply.failure({
			scope: "Authentication",
			code: "INVALID_ARGUMENTS",
			message: "RetryAuthFlow requires a provider parameter",
			retryable: false,
		});
		return;
	}

	if (ctx.clientState.authFlow?.provider === payload.provider && ctx.clientState.authFlow.retry) {
		ctx.clientState.authFlow.retry();
		ctx.reply.success();
		return;
	}

	await handleStartProviderAuth(ctx, payload);
};

interface SignOutAccountPayload {
	provider?: string;
	credential_id?: number;
}

/**
 * Removes one stored credential by its row, which is what the terminal's
 * account card does, so a provider's other accounts stay signed in.
 *
 * The store is reloaded first, so a credential stored or removed by another
 * process is the one acted on. A key the provider also reads from an
 * environment variable or a config file is not stored and stays; the
 * `Providers` section this answers with still states it authenticated.
 */
const handleSignOutAccount: ActionHandler<SignOutAccountPayload | undefined> = async (ctx, payload) => {
	if (!payload?.provider || typeof payload.credential_id !== "number") {
		ctx.reply.failure({
			scope: "Authentication",
			code: "INVALID_ARGUMENTS",
			message: "SignOutAccount requires provider and credential_id parameters",
			retryable: false,
		});
		return;
	}
	const { provider, credential_id: credentialId } = payload;
	try {
		const authStorage = await ctx.authStorage();
		await authStorage.reload();
		if (!(await authStorage.removeCredential(provider, credentialId))) {
			ctx.reply.failure({
				scope: "Authentication",
				code: "ACCOUNT_NOT_STORED",
				message: `${formatProviderName(provider)} credential #${credentialId} is no longer stored`,
				retryable: false,
			});
			return;
		}
		for (const section of await providerSections(ctx, authStorage)) ctx.reply.snapshot(section);
		await publishModelsAfterAuthChange(ctx);
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Authentication",
			code: "SIGN_OUT_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

export const providersActionHandlers: ActionHandlersMap = {
	RefreshProviders: handleRefreshProviders as ActionHandler<never>,
	StartProviderAuth: handleStartProviderAuth as ActionHandler<never>,
	SubmitAuthSecret: handleSubmitAuthSecret as ActionHandler<never>,
	OpenAuthUrl: handleOpenAuthUrl as ActionHandler<never>,
	CancelAuthFlow: handleCancelAuthFlow as ActionHandler<never>,
	RetryAuthFlow: handleRetryAuthFlow as ActionHandler<never>,
	SignOutAccount: handleSignOutAccount as ActionHandler<never>,
};
