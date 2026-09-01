import type { AuthStorage } from "@veyyon/ai";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";
import { formatProviderName } from "../../slash-commands/helpers/format";
import { openPath } from "../../utils/open";
import { writeFrame } from "../frames";
import type { ActiveAuthFlow } from "../turns";
import type { AuthFlowView, ProviderView } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

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

const handleRefreshProviders: ActionHandler = async ctx => {
	try {
		const providers = buildProvidersView(await ctx.authStorage());
		ctx.reply.snapshot({
			Providers: providers,
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Provider",
			code: "PROVIDER_REFRESH_FAILED",
			message: error instanceof Error ? error.message : String(error),
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

				const providers = buildProvidersView(await ctx.authStorage());
				writeFrame(ctx.socket, { Snapshot: { Providers: providers } });
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
					const errorMessage = err instanceof Error ? err.message : String(err);
					const failedView: AuthFlowView = {
						provider: providerId,
						state: "Failed",
						url: null,
						prompt: null,
						message: errorMessage,
					};
					if (ctx.clientState.authFlow) {
						ctx.clientState.authFlow.state = "Failed";
						ctx.clientState.authFlow.message = errorMessage;
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

interface RefreshAuthPayload {
	provider?: string;
}

const handleRefreshAuth: ActionHandler<RefreshAuthPayload | undefined> = async (ctx, _payload) => {
	try {
		const providers = buildProvidersView(await ctx.authStorage());
		ctx.reply.snapshot({
			Providers: providers,
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Provider",
			code: "PROVIDER_REFRESH_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
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
		const providers = buildProvidersView(await ctx.authStorage());
		ctx.reply.snapshot({
			Providers: providers,
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Authentication",
			code: "SET_API_KEY_FAILED",
			message: error instanceof Error ? error.message : String(error),
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

export const providersActionHandlers: ActionHandlersMap = {
	RefreshProviders: handleRefreshProviders as ActionHandler<never>,
	StartProviderAuth: handleStartProviderAuth as ActionHandler<never>,
	RefreshAuth: handleRefreshAuth as ActionHandler<never>,
	SubmitAuthSecret: handleSubmitAuthSecret as ActionHandler<never>,
	OpenAuthUrl: handleOpenAuthUrl as ActionHandler<never>,
	CancelAuthFlow: handleCancelAuthFlow as ActionHandler<never>,
	RetryAuthFlow: handleRetryAuthFlow as ActionHandler<never>,
};
