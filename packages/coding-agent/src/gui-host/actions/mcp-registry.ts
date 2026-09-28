/**
 * The Smithery registry from the desktop: searching it, adding a server from
 * the last search, and the profile's Smithery sign-in. The key is the file the
 * terminal's `/mcp smithery-login` writes, `<agentDir>/smithery.json`, or
 * `SMITHERY_API_KEY` in the host's environment.
 */
import { errorMessage } from "@veyyon/utils";
import { readMCPConfigFile } from "../../mcp/config-writer";
import {
	applyRegistryInputOverrides,
	nextAvailableServerName,
	validateSmitheryApiKey,
	waitForSmitheryCliApiKey,
} from "../../mcp/management";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	saveSmitheryApiKey,
} from "../../mcp/smithery-auth";
import {
	SmitheryRegistryError,
	type SmitherySearchResult,
	searchSmitheryRegistry,
	toConfigName,
} from "../../mcp/smithery-registry";
import type { ProviderTextTransformResolver } from "../../provider-boundary";
import { writeFrame } from "../frames";
import type { ActiveAuthFlow, ClientSessionState } from "../turns";
import type { McpRegistryInputValue, McpRegistryView } from "../wire";
import { acceptPastes, authFlowBusyMessage, publishAuthFlow, runAuthFlow } from "./mcp-auth";
import {
	addServerToProfile,
	failMcp,
	mcpManagerFor,
	mcpUserConfigPath,
	refuseServerName,
	replyMcpSections,
} from "./mcp-runtime";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

/** The provider a Smithery sign-in runs under in the `AuthFlow` section. */
const SMITHERY_PROVIDER = "smithery";
/** The paste field's label while a Smithery sign-in waits for a key. */
const SMITHERY_KEY_PROMPT = "Smithery API key";

/** Each window's last search, which `DeployMcpRegistryServer` names a result of. */
const lastSearch = new WeakMap<ClientSessionState, { query: string; results: SmitherySearchResult[] }>();

/** The session's outbound redaction, applied to a search query and a key check. */
function outboundTransform(ctx: ActionContext): ProviderTextTransformResolver | undefined {
	const session = ctx.clientState.agentSession;
	return session ? () => text => session.obfuscateProviderText(text) : undefined;
}

/** The registry as this window last searched it, with a name per result no server in the profile holds. */
async function registryView(ctx: ActionContext): Promise<McpRegistryView> {
	const [apiKey, own] = await Promise.all([
		getSmitheryApiKey(ctx.agentDir),
		readMCPConfigFile(mcpUserConfigPath(ctx)),
	]);
	const taken = new Set(Object.keys(own.mcpServers ?? {}));
	const search = lastSearch.get(ctx.clientState);
	return {
		signed_in: apiKey !== undefined,
		query: search?.query ?? null,
		results: (search?.results ?? []).map(result => ({
			id: result.id,
			name: result.display.displayName,
			description: result.display.description,
			transport: result.display.transport,
			use_count: result.display.useCount,
			verified: result.display.verified,
			server: nextAvailableServerName(taken, toConfigName(result.name)),
			warnings: result.warnings,
			inputs: result.requiredInputs.map(input => ({
				key: input.key,
				label: input.label,
				description: input.description ?? null,
				required: input.required,
				default: input.defaultValue ?? null,
				sensitive: input.sensitive,
				choices: input.enumValues ?? [],
			})),
		})),
	};
}

interface SearchMcpRegistryPayload {
	query?: string;
	limit?: number | null;
	semantic?: boolean;
}

/**
 * Search the registry with the profile's key. Searching signed out fails the
 * request rather than starting a sign-in the window did not ask for; a key the
 * registry rejects fails it the same way, so the window can offer a sign-in.
 */
const handleSearchMcpRegistry: ActionHandler<SearchMcpRegistryPayload | undefined> = async (ctx, payload) => {
	const query = payload?.query?.trim();
	const limit = payload?.limit ?? undefined;
	if (!query || (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))) {
		failMcp(
			ctx,
			"INVALID_ARGUMENTS",
			"SearchMcpRegistry requires a query and a limit from 1 to 100 when one is given",
		);
		return;
	}
	const apiKey = await getSmitheryApiKey(ctx.agentDir);
	if (!apiKey) {
		failMcp(
			ctx,
			"MCP_REGISTRY_SIGNED_OUT",
			"Searching the Smithery registry needs a Smithery key. Fix: sign in to Smithery.",
		);
		return;
	}
	let results: SmitherySearchResult[];
	try {
		results = await searchSmitheryRegistry(query, {
			limit,
			apiKey,
			includeSemantic: payload?.semantic === true,
			resolveProviderTextTransform: outboundTransform(ctx),
		});
	} catch (error) {
		const status = error instanceof SmitheryRegistryError ? error.status : undefined;
		const code =
			status === 401 || status === 403
				? "MCP_REGISTRY_KEY_REJECTED"
				: status === 429
					? "MCP_REGISTRY_RATE_LIMITED"
					: "MCP_REGISTRY_SEARCH_FAILED";
		failMcp(ctx, code, `Smithery search failed: ${errorMessage(error)}`);
		return;
	}
	lastSearch.set(ctx.clientState, { query, results });
	ctx.reply.snapshot({ McpRegistry: await registryView(ctx) });
	ctx.reply.success();
};

interface DeployMcpRegistryServerPayload {
	result?: string;
	server?: string;
	inputs?: McpRegistryInputValue[];
}

/**
 * The launch values for `result`: each input given, else its default. Returns
 * the refusal instead when an input is one the result does not declare, or a
 * required one has neither.
 */
function registryInputValues(
	result: SmitherySearchResult,
	given: readonly McpRegistryInputValue[],
): Record<string, string> | string {
	const declared = new Map(result.requiredInputs.map(input => [input.key, input]));
	const values: Record<string, string> = {};
	for (const { key, value } of given) {
		if (!declared.has(key)) return `The registry result '${result.id}' declares no input '${key}'.`;
		if (value.trim()) values[key] = value.trim();
	}
	for (const input of declared.values()) {
		if (values[input.key] !== undefined) continue;
		if (input.defaultValue !== undefined && input.defaultValue !== "") values[input.key] = input.defaultValue;
		else if (input.required) return `The registry result '${result.id}' requires a value for '${input.key}'.`;
	}
	return values;
}

const handleDeployMcpRegistryServer: ActionHandler<DeployMcpRegistryServerPayload | undefined> = async (
	ctx,
	payload,
) => {
	const name = payload?.server?.trim();
	if (!payload?.result || !name) {
		failMcp(ctx, "INVALID_ARGUMENTS", "DeployMcpRegistryServer requires a result and a server name");
		return;
	}
	const result = lastSearch.get(ctx.clientState)?.results.find(candidate => candidate.id === payload.result);
	if (!result) {
		failMcp(
			ctx,
			"MCP_REGISTRY_RESULT_UNKNOWN",
			`The registry result '${payload.result}' is not in this window's last search. Fix: search again.`,
		);
		return;
	}
	const values = registryInputValues(result, payload.inputs ?? []);
	if (typeof values === "string") {
		failMcp(ctx, "INVALID_ARGUMENTS", values);
		return;
	}
	try {
		const manager = await mcpManagerFor(ctx);
		const refusal = await refuseServerName(ctx, manager, name);
		if (refusal) {
			failMcp(ctx, "MCP_SERVER_NAME_REFUSED", refusal);
			return;
		}
		await addServerToProfile(ctx, manager, name, applyRegistryInputOverrides(result.config, values));
		await replyMcpSections(ctx, manager);
		ctx.reply.snapshot({ McpRegistry: await registryView(ctx) });
		ctx.reply.success();
	} catch (error) {
		failMcp(ctx, "MCP_ADD_FAILED", errorMessage(error));
	}
};

/** A key that arrived for a Smithery sign-in, or the browser step's failure. */
type SmitheryArrival = { key: string; pasted: boolean } | { browserFailure: unknown };

/**
 * Wait for a Smithery key from the browser step or from `SubmitAuthSecret`,
 * validate and store it. A pasted key the registry rejects is reported on the
 * flow and another is awaited; a browser step that fails leaves the paste. The
 * browser step ends after five minutes and on `CancelAuthFlow`, which rejects
 * the paste; a paste-only sign-in ends on `CancelAuthFlow` or when the window
 * disconnects.
 */
async function completeSmitheryLogin(
	ctx: ActionContext,
	flow: ActiveAuthFlow,
	cancel: AbortSignal,
	browser: Promise<string> | undefined,
	nextPaste: () => Promise<string>,
): Promise<void> {
	let fromBrowser = browser?.then(
		(key): SmitheryArrival => ({ key, pasted: false }),
		(browserFailure: unknown): SmitheryArrival => ({ browserFailure }),
	);
	for (;;) {
		const fromPaste = nextPaste().then((key): SmitheryArrival => ({ key, pasted: true }));
		let arrival: SmitheryArrival;
		try {
			arrival = await (fromBrowser ? Promise.race([fromPaste, fromBrowser]) : fromPaste);
		} catch {
			// `CancelAuthFlow` rejected the paste and states the cancellation itself.
			return;
		}
		if (cancel.aborted) return;
		if ("browserFailure" in arrival) {
			fromBrowser = undefined;
			flow.state = "AwaitingSecret";
			flow.prompt = SMITHERY_KEY_PROMPT;
			flow.message = `Browser sign-in failed: ${errorMessage(arrival.browserFailure)}`;
			publishAuthFlow(ctx, flow);
			continue;
		}
		try {
			await validateSmitheryApiKey(arrival.key, outboundTransform(ctx));
			await saveSmitheryApiKey(arrival.key, ctx.agentDir);
		} catch (error) {
			if (cancel.aborted) return;
			if (!arrival.pasted) fromBrowser = undefined;
			flow.state = "AwaitingSecret";
			flow.prompt = SMITHERY_KEY_PROMPT;
			flow.message = `Smithery rejected the key: ${errorMessage(error)}`;
			publishAuthFlow(ctx, flow);
			continue;
		}
		flow.state = "Completed";
		flow.url = null;
		flow.prompt = null;
		flow.message = null;
		publishAuthFlow(ctx, flow);
		writeFrame(ctx.socket, { Snapshot: { McpRegistry: await registryView(ctx) } });
		return;
	}
}

/**
 * Sign in to Smithery. The browser step's link arrives as `AuthFlow` under the
 * provider `smithery`; a key pasted with `SubmitAuthSecret` is taken instead.
 * When the browser step cannot start, the flow asks for the key alone.
 */
const handleLoginMcpRegistry: ActionHandler = ctx => {
	const started = runAuthFlow(ctx, SMITHERY_PROVIDER, async (flow, cancel) => {
		const pastes = acceptPastes(flow);
		try {
			let browser: Promise<string> | undefined;
			try {
				const session = await createSmitheryCliAuthSession();
				// The browser step mints a key on its own; a key pasted before it does is taken instead.
				flow.state = "AwaitingSecret";
				flow.url = session.authUrl;
				flow.prompt = SMITHERY_KEY_PROMPT;
				browser = waitForSmitheryCliApiKey(session.sessionId, cancel);
			} catch (error) {
				flow.state = "AwaitingSecret";
				flow.prompt = SMITHERY_KEY_PROMPT;
				flow.message = `Browser sign-in could not start: ${errorMessage(error)}`;
			}
			if (cancel.aborted) return;
			publishAuthFlow(ctx, flow);
			await completeSmitheryLogin(ctx, flow, cancel, browser, pastes.next);
		} finally {
			pastes.release();
		}
	});
	if (!started) {
		failMcp(ctx, "AUTH_FLOW_IN_PROGRESS", authFlowBusyMessage(ctx));
		return;
	}
	ctx.reply.success();
};

/** Delete the profile's stored Smithery key. A key the environment sets stays, and the section says so. */
const handleLogoutMcpRegistry: ActionHandler = async ctx => {
	try {
		const removed = await clearSmitheryApiKey(ctx.agentDir);
		ctx.reply.snapshot({ McpRegistry: await registryView(ctx) });
		if (!removed) {
			failMcp(ctx, "MCP_REGISTRY_NO_STORED_KEY", "This profile has no stored Smithery key to delete");
			return;
		}
		ctx.reply.success();
	} catch (error) {
		failMcp(ctx, "MCP_REGISTRY_LOGOUT_FAILED", errorMessage(error));
	}
};

export const mcpRegistryActionHandlers: ActionHandlersMap = {
	SearchMcpRegistry: handleSearchMcpRegistry as ActionHandler<never>,
	DeployMcpRegistryServer: handleDeployMcpRegistryServer as ActionHandler<never>,
	LoginMcpRegistry: handleLoginMcpRegistry as ActionHandler<never>,
	LogoutMcpRegistry: handleLogoutMcpRegistry as ActionHandler<never>,
};
