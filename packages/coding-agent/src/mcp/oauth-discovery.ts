import * as AIError from "@veyyon/ai/error";
import type { FetchImpl } from "@veyyon/ai/types";
import { errorMessage, logger, trimTrailingSlashes } from "@veyyon/utils";

export interface OAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	clientId?: string;
	registrationUrl?: string;
	scopes?: string;
	resource?: string;
}

function readRegistrationUrl(metadata: Record<string, unknown>): string | undefined {
	const value =
		metadata.registration_endpoint ??
		metadata.registrationEndpoint ??
		metadata.registration_url ??
		metadata.registrationUrl ??
		metadata.registration_uri ??
		metadata.registrationUri;
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export interface AuthDetectionResult {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: OAuthEndpoints;
	authServerUrl?: string;
	resourceMetadataUrl?: string;
	scopes?: string;
	message?: string;
}

export function extractMcpAuthServerUrl(error: Error, serverUrl?: string): string | undefined {
	const match = error.message.match(/Mcp-Auth-Server:\s*([^;\]\s]+)/i);
	if (!match?.[1]) return undefined;

	try {
		return new URL(match[1], serverUrl).toString();
	} catch {
		return undefined;
	}
}

export function extractOAuthChallengeScopes(error: Error): string | undefined {
	const entries = error.message.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g);
	for (const [, rawKey, value] of entries) {
		const key = rawKey.toLowerCase();
		if ((key === "scope" || key === "scopes") && value.trim() !== "") {
			return value;
		}
	}
	return undefined;
}

export function extractOAuthEndpoints(error: Error): OAuthEndpoints | null {
	const errorMsg = error.message;

	const readEndpointsFromObject = (obj: Record<string, unknown>): OAuthEndpoints | null => {
		const authorizationUrl =
			(obj.authorization_url as string | undefined) ||
			(obj.authorizationUrl as string | undefined) ||
			(obj.authorization_endpoint as string | undefined) ||
			(obj.authorizationEndpoint as string | undefined) ||
			(obj.authorization_uri as string | undefined) ||
			(obj.authorizationUri as string | undefined);
		const tokenUrl =
			(obj.token_url as string | undefined) ||
			(obj.tokenUrl as string | undefined) ||
			(obj.token_endpoint as string | undefined) ||
			(obj.tokenEndpoint as string | undefined) ||
			(obj.token_uri as string | undefined) ||
			(obj.tokenUri as string | undefined);

		if (!authorizationUrl || !tokenUrl) return null;

		const scopeFromArray = Array.isArray(obj.scopes_supported)
			? (obj.scopes_supported as unknown[]).filter(v => typeof v === "string").join(" ")
			: undefined;
		const scopes = (obj.scopes as string | undefined) || (obj.scope as string | undefined) || scopeFromArray;
		const clientId =
			(obj.client_id as string | undefined) ||
			(obj.clientId as string | undefined) ||
			(obj.default_client_id as string | undefined) ||
			(obj.public_client_id as string | undefined);

		const resource =
			(obj.resource as string | undefined) ||
			(obj.resource_uri as string | undefined) ||
			(obj.resourceUri as string | undefined);

		return { authorizationUrl, tokenUrl, registrationUrl: readRegistrationUrl(obj), clientId, scopes, resource };
	};

	const clientIdFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("client_id") ?? undefined;
		} catch {
			return undefined;
		}
	};

	const scopeFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("scope") ?? undefined;
		} catch {
			return undefined;
		}
	};

	try {
		const jsonMatch = errorMsg.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const errorBody = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

			if (errorBody.oauth || errorBody.authorization || errorBody.auth) {
				const oauthData = (errorBody.oauth || errorBody.authorization || errorBody.auth) as Record<string, unknown>;
				const endpoints = readEndpointsFromObject(oauthData);
				if (endpoints) {
					return {
						...endpoints,
						clientId: endpoints.clientId || clientIdFromAuthUrl(endpoints.authorizationUrl),
						scopes: endpoints.scopes || scopeFromAuthUrl(endpoints.authorizationUrl),
					};
				}
			}

			const topLevelEndpoints = readEndpointsFromObject(errorBody);
			if (topLevelEndpoints) {
				return {
					...topLevelEndpoints,
					clientId: topLevelEndpoints.clientId || clientIdFromAuthUrl(topLevelEndpoints.authorizationUrl),
					scopes: topLevelEndpoints.scopes || scopeFromAuthUrl(topLevelEndpoints.authorizationUrl),
				};
			}
		}
	} catch {}

	const challengeEntries = Array.from(errorMsg.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g));
	if (challengeEntries.length > 0) {
		const challengeValues = new Map<string, string>();
		for (const [, rawKey, value] of challengeEntries) {
			challengeValues.set(rawKey.toLowerCase(), value);
		}

		const authorizationUrl =
			challengeValues.get("authorization_uri") ||
			challengeValues.get("authorization_url") ||
			challengeValues.get("authorization_endpoint") ||
			challengeValues.get("authorize_url") ||
			challengeValues.get("realm");
		const tokenUrl =
			challengeValues.get("token_url") || challengeValues.get("token_uri") || challengeValues.get("token_endpoint");
		const resource = challengeValues.get("resource") || challengeValues.get("resource_uri");

		if (authorizationUrl && tokenUrl) {
			return {
				authorizationUrl,
				tokenUrl,
				registrationUrl:
					challengeValues.get("registration_endpoint") ||
					challengeValues.get("registration_url") ||
					challengeValues.get("registration_uri"),
				clientId: challengeValues.get("client_id") || clientIdFromAuthUrl(authorizationUrl),
				scopes: challengeValues.get("scope") || challengeValues.get("scopes") || scopeFromAuthUrl(authorizationUrl),
				resource,
			};
		}
	}

	const wwwAuthMatch = errorMsg.match(/realm="([^"]+)".*token_url="([^"]+)"/);
	if (wwwAuthMatch) {
		return {
			authorizationUrl: wwwAuthMatch[1],
			tokenUrl: wwwAuthMatch[2],
			clientId: clientIdFromAuthUrl(wwwAuthMatch[1]),
			scopes: scopeFromAuthUrl(wwwAuthMatch[1]),
		};
	}

	return null;
}

export function analyzeAuthError(error: Error, serverUrl?: string): AuthDetectionResult {
	if (!AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) {
		return { requiresAuth: false };
	}

	const authServerUrl = extractMcpAuthServerUrl(error, serverUrl);
	const resourceMetaMatch = error.message.match(/resource_metadata\s*=\s*"([^"]+)"/i);
	const resourceMetadataUrl = resourceMetaMatch?.[1];

	const oauth = extractOAuthEndpoints(error);
	const challengeScopes = extractOAuthChallengeScopes(error);

	if (oauth) {
		const mergedScopes = oauth.scopes ?? challengeScopes;
		const mergedOAuth: OAuthEndpoints = mergedScopes === oauth.scopes ? oauth : { ...oauth, scopes: mergedScopes };
		return {
			requiresAuth: true,
			authType: "oauth",
			oauth: mergedOAuth,
			authServerUrl,
			resourceMetadataUrl,
			scopes: mergedScopes,
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}

	const errorMsg = error.message.toLowerCase();
	if (
		errorMsg.includes("api key") ||
		errorMsg.includes("api_key") ||
		errorMsg.includes("token") ||
		errorMsg.includes("bearer")
	) {
		return {
			requiresAuth: true,
			authType: "apikey",
			authServerUrl,
			resourceMetadataUrl,
			scopes: challengeScopes,
			message: "Server requires API key authentication.",
		};
	}

	return {
		requiresAuth: true,
		authType: "unknown",
		authServerUrl,
		resourceMetadataUrl,
		scopes: challengeScopes,
		message: "Server requires authentication but type could not be determined.",
	};
}

function normalizeIssuerUrl(value: string): string | undefined {
	try {
		const u = new URL(value);
		const path = trimTrailingSlashes(u.pathname);
		return `${u.protocol}//${u.host}${path}`;
	} catch {
		return undefined;
	}
}

function issuerMatchesBase(metadataIssuer: unknown, baseUrl: string): boolean {
	if (typeof metadataIssuer !== "string" || !metadataIssuer.trim()) {
		return true;
	}
	const normalizedIssuer = normalizeIssuerUrl(metadataIssuer);
	const normalizedBase = normalizeIssuerUrl(baseUrl);
	if (!normalizedIssuer || !normalizedBase) return false;
	return normalizedIssuer === normalizedBase;
}

function readMetadataScopes(metadata: Record<string, unknown>): string | undefined {
	if (Array.isArray(metadata.scopes_supported)) {
		const joined = metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ");
		if (joined) return joined;
	}
	if (typeof metadata.scopes === "string" && metadata.scopes.trim() !== "") return metadata.scopes;
	if (typeof metadata.scope === "string" && metadata.scope.trim() !== "") return metadata.scope;
	return undefined;
}

export async function fetchResourceMetadataScopes(
	resourceMetadataUrl: string,
	opts?: { fetch?: FetchImpl },
): Promise<string | undefined> {
	const fetchImpl: FetchImpl = opts?.fetch ?? fetch;
	try {
		const resp = await fetchImpl(resourceMetadataUrl, {
			method: "GET",
			headers: { Accept: "application/json" },
			redirect: "follow",
		});
		if (!resp.ok) {
			logger.warn("Protected-resource metadata could not be fetched; the grant will carry no advertised scopes", {
				url: resourceMetadataUrl,
				status: resp.status,
			});
			return undefined;
		}
		const meta = (await resp.json()) as Record<string, unknown>;
		return readMetadataScopes(meta);
	} catch (error) {
		logger.warn("Protected-resource metadata could not be read; the grant will carry no advertised scopes", {
			url: resourceMetadataUrl,
			error: errorMessage(error),
		});
		return undefined;
	}
}

export async function discoverOAuthEndpoints(
	serverUrl: string,
	authServerUrl?: string,
	resourceMetadataUrl?: string,
	opts?: { fetch?: FetchImpl; protectedResource?: string; protectedScopes?: string },
): Promise<OAuthEndpoints | null> {
	const fetchImpl: FetchImpl = opts?.fetch ?? fetch;
	const wellKnownPaths = [
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/.well-known/oauth-protected-resource",
		"/oauth/metadata",
		"/.mcp/auth",
		"/authorize", // Some MCP servers expose OAuth config here
	];
	const urlsToQuery: Array<{ url: string; issuerCandidate: boolean }> = [];
	const visitedAuthServers = new Set<string>();

	let protectedResource = opts?.protectedResource;
	let protectedScopes = opts?.protectedScopes;
	const addDiscoveryBase = (url: string | undefined, issuerCandidate: boolean): void => {
		if (!url || visitedAuthServers.has(url)) return;
		urlsToQuery.push({ url, issuerCandidate });
		visitedAuthServers.add(url);
	};

	if (resourceMetadataUrl && !visitedAuthServers.has(resourceMetadataUrl)) {
		visitedAuthServers.add(resourceMetadataUrl);
		try {
			const metaResp = await fetchImpl(resourceMetadataUrl, {
				method: "GET",
				headers: { Accept: "application/json" },
				redirect: "follow",
			});
			if (metaResp.ok) {
				const meta = (await metaResp.json()) as Record<string, unknown>;
				protectedScopes = readMetadataScopes(meta) ?? protectedScopes;
				if (typeof meta.resource === "string" && meta.resource.trim() !== "") {
					protectedResource = meta.resource;
				}
				const authServers = Array.isArray(meta.authorization_servers)
					? meta.authorization_servers.filter((entry): entry is string => typeof entry === "string")
					: [];
				for (const s of authServers) {
					addDiscoveryBase(s, true);
				}
			}
		} catch {}
	}

	addDiscoveryBase(authServerUrl, true);
	addDiscoveryBase(serverUrl, false);

	const findEndpoints = (metadata: Record<string, unknown>): OAuthEndpoints | null => {
		if (metadata.authorization_endpoint && metadata.token_endpoint) {
			const resource = typeof metadata.resource === "string" ? metadata.resource : protectedResource;

			return {
				authorizationUrl: String(metadata.authorization_endpoint),
				tokenUrl: String(metadata.token_endpoint),
				registrationUrl: readRegistrationUrl(metadata),
				clientId:
					typeof metadata.client_id === "string"
						? metadata.client_id
						: typeof metadata.clientId === "string"
							? metadata.clientId
							: typeof metadata.default_client_id === "string"
								? metadata.default_client_id
								: typeof metadata.public_client_id === "string"
									? metadata.public_client_id
									: undefined,
				scopes: readMetadataScopes(metadata) ?? protectedScopes,
				resource,
			};
		}

		if (metadata.oauth || metadata.authorization || metadata.auth) {
			const oauthData = (metadata.oauth || metadata.authorization || metadata.auth) as Record<string, unknown>;
			if (typeof oauthData.authorization_url === "string" && typeof oauthData.token_url === "string") {
				const resource = typeof oauthData.resource === "string" ? oauthData.resource : protectedResource;

				return {
					authorizationUrl: oauthData.authorization_url || String(oauthData.authorizationUrl),
					tokenUrl: oauthData.token_url || String(oauthData.tokenUrl),
					registrationUrl: readRegistrationUrl(oauthData),
					clientId:
						typeof oauthData.client_id === "string"
							? oauthData.client_id
							: typeof oauthData.clientId === "string"
								? oauthData.clientId
								: typeof oauthData.default_client_id === "string"
									? oauthData.default_client_id
									: typeof oauthData.public_client_id === "string"
										? oauthData.public_client_id
										: undefined,
					scopes: readMetadataScopes(oauthData) ?? protectedScopes,
					resource,
				};
			}
		}

		return null;
	};

	for (const base of urlsToQuery) {
		for (const path of wellKnownPaths) {
			const urlsToTry = buildWellKnownUrls(path, base.url);
			for (const url of urlsToTry) {
				try {
					const response = await fetchImpl(url.toString(), {
						method: "GET",
						headers: { Accept: "application/json" },
						redirect: "follow",
					});

					if (response.ok) {
						const metadata = (await response.json()) as Record<string, unknown>;
						const requireIssuerMatch =
							base.issuerCandidate &&
							(path === "/.well-known/oauth-authorization-server" ||
								path === "/.well-known/openid-configuration");
						const issuerOk = requireIssuerMatch ? issuerMatchesBase(metadata.issuer, base.url) : true;
						const endpoints = issuerOk ? findEndpoints(metadata) : null;
						if (endpoints) return endpoints;

						if (path === "/.well-known/oauth-protected-resource") {
							const authServers = Array.isArray(metadata.authorization_servers)
								? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string")
								: [];

							const discoveredProtectedResource =
								typeof metadata.resource === "string" && metadata.resource.trim() !== ""
									? metadata.resource
									: protectedResource;

							for (const discoveredAuthServer of authServers) {
								if (visitedAuthServers.has(discoveredAuthServer)) {
									continue;
								}
								const discovered = await discoverOAuthEndpoints(serverUrl, discoveredAuthServer, undefined, {
									fetch: fetchImpl,
									protectedResource: discoveredProtectedResource,
									protectedScopes: readMetadataScopes(metadata) ?? protectedScopes,
								});
								if (discovered) return discovered;
							}
						}
					}
				} catch {}
			}
		}
	}

	return null;
}

function buildWellKnownUrls(wellKnownPath: string, baseUrl: string): URL[] {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return [];
	}

	const absUrl = new URL(wellKnownPath, parsed);
	if (!wellKnownPath.startsWith("/")) return [absUrl];

	const normalizedPath = parsed.pathname.replace(/\/$/, "");
	const lastSlash = normalizedPath.lastIndexOf("/");
	if (lastSlash < 0) return [absUrl];

	const prefixPath = lastSlash === 0 ? normalizedPath : normalizedPath.slice(0, lastSlash);
	const relUrl = new URL(wellKnownPath.slice(1), `${parsed.origin}${prefixPath}/`);

	const candidates: URL[] = [absUrl];
	const seen = new Set<string>([absUrl.href]);
	const push = (u: URL): void => {
		if (!seen.has(u.href)) {
			candidates.push(u);
			seen.add(u.href);
		}
	};
	push(relUrl);

	if (wellKnownPath.startsWith("/.well-known/")) {
		const pathfulUrl = new URL(`${wellKnownPath}${normalizedPath}`, parsed.origin);
		push(pathfulUrl);
	}

	return candidates;
}
