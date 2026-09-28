/**
 * Sign-ins an MCP action starts, drawn through the window's `AuthFlow` section
 * the way a provider login is: `OpenAuthUrl` opens the link, `SubmitAuthSecret`
 * answers with a pasted redirect URL or key, and `CancelAuthFlow` stops it. An
 * MCP server's OAuth login runs under the provider `mcp:<server>`, a Smithery
 * sign-in under `smithery`.
 *
 * The request that starts a sign-in succeeds once the sign-in is running. A
 * login waits on the browser for up to five minutes, longer than a request
 * stays in flight, so how it ends is stated by the `AuthFlow` section instead.
 */
import { errorMessage } from "@veyyon/utils";
import {
	commitMcpReauth,
	MCPOAuthCancelledError,
	type McpOAuthFlowParams,
	type McpReauthPlan,
	type OAuthFlowResult,
	planMcpReauth,
	runMcpOAuthFlow,
} from "../../mcp/management";
import { writeFrame } from "../frames";
import type { ActiveAuthFlow } from "../turns";
import {
	connectConfiguredServer,
	failMcp,
	findMcpServer,
	mcpManagerFor,
	mcpUserConfigPath,
	preparerFor,
	publishMcpSections,
} from "./mcp-runtime";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

/** Send the sign-in's state to the window that started it. */
export function publishAuthFlow(ctx: ActionContext, flow: ActiveAuthFlow): void {
	writeFrame(ctx.socket, {
		Snapshot: {
			AuthFlow: {
				provider: flow.provider,
				state: flow.state,
				url: flow.url,
				prompt: flow.prompt,
				message: flow.message,
			},
		},
	});
}

/** True while a sign-in waits on the browser or on a secret. */
function isWaiting(flow: ActiveAuthFlow): boolean {
	return flow.state === "AwaitingBrowser" || flow.state === "AwaitingSecret";
}

/**
 * Install a sign-in as this window's one auth flow and start `run` on it, or
 * return false when another is still waiting on the browser or a secret.
 * Replacing it would orphan a login the window can then neither finish nor
 * cancel. `RetryAuthFlow` starts `run` again on the same flow once the last
 * attempt has ended; each attempt gets its own cancel signal, which
 * `CancelAuthFlow` and the window disconnecting abort.
 */
export function runAuthFlow(
	ctx: ActionContext,
	provider: string,
	run: (flow: ActiveAuthFlow, cancel: AbortSignal) => Promise<void>,
): boolean {
	const current = ctx.clientState.authFlow;
	if (current && isWaiting(current)) return false;
	const flow: ActiveAuthFlow = {
		provider,
		state: "AwaitingBrowser",
		url: null,
		prompt: null,
		message: null,
		type: "oauth",
	};
	const start = (): void => {
		const abort = new AbortController();
		flow.abortController = abort;
		flow.state = "AwaitingBrowser";
		flow.url = null;
		flow.prompt = null;
		flow.message = null;
		void run(flow, abort.signal);
	};
	flow.retry = () => {
		if (!isWaiting(flow)) start();
	};
	ctx.clientState.authFlow = flow;
	start();
	return true;
}

/** The refusal for a sign-in started while another is running. */
export function authFlowBusyMessage(ctx: ActionContext): string {
	return `A sign-in for ${ctx.clientState.authFlow?.provider ?? "another provider"} is still running. Fix: finish it or cancel it, then try again.`;
}

/**
 * Take every `SubmitAuthSecret` for `flow` from now until `release`, handing
 * each to the login's next request for a pasted redirect URL. A paste that
 * arrives before the login asks for one waits for it, the latest replacing an
 * earlier one, so no paste falls through to the api-key store under the
 * flow's provider name. `release` leaves a later attempt's resolver in place.
 */
export function acceptPastes(flow: ActiveAuthFlow): { next: () => Promise<string>; release: () => void } {
	let early: string | undefined;
	let waiting: PromiseWithResolvers<string> | undefined;
	const accept = (secret: string): void => {
		// `SubmitAuthSecret` clears the resolver before calling it.
		flow.secretResolver = accept;
		if (waiting) {
			waiting.resolve(secret);
			waiting = undefined;
		} else {
			early = secret;
		}
	};
	flow.secretResolver = accept;
	return {
		next: () => {
			if (early !== undefined) {
				const pasted = early;
				early = undefined;
				return Promise.resolve(pasted);
			}
			waiting = Promise.withResolvers<string>();
			flow.secretRejecter = waiting.reject;
			return waiting.promise;
		},
		release: () => {
			if (flow.secretResolver !== accept) return;
			flow.secretResolver = undefined;
			flow.secretRejecter = undefined;
		},
	};
}

/** The paste field's label while an MCP login waits on the browser. */
const MCP_REDIRECT_PROMPT = "Redirect URL the browser was sent to";

/**
 * Run `server`'s OAuth login under the provider `mcp:<server>`, then `finish`
 * with the stored credential. Returns false without starting when another
 * sign-in is running. A redirect URL pasted with `SubmitAuthSecret` completes
 * the login when the browser cannot reach the callback.
 */
export function startMcpLogin(
	ctx: ActionContext,
	server: string,
	params: McpOAuthFlowParams,
	finish: (result: OAuthFlowResult) => Promise<void>,
): boolean {
	return runAuthFlow(ctx, `mcp:${server}`, async (flow, cancel) => {
		const pastes = acceptPastes(flow);
		try {
			const result = await runMcpOAuthFlow(params, {
				authStorage: await ctx.authStorage(),
				cancel,
				onAuth: info => {
					// The browser's redirect finishes the login on its own; the pasted
					// redirect URL is for a browser that cannot reach this machine.
					flow.state = "AwaitingSecret";
					flow.url = info.url;
					flow.prompt = MCP_REDIRECT_PROMPT;
					flow.message = info.instructions ?? null;
					publishAuthFlow(ctx, flow);
				},
				onProgress: message => {
					flow.message = message;
				},
				onManualCodeInput: pastes.next,
			});
			await finish(result);
			flow.state = "Completed";
			flow.url = null;
			flow.prompt = null;
			flow.message = null;
		} catch (error) {
			// `CancelAuthFlow` states the cancellation itself.
			if (error instanceof MCPOAuthCancelledError || cancel.aborted) return;
			flow.state = "Failed";
			flow.url = null;
			flow.prompt = null;
			flow.message = errorMessage(error);
		} finally {
			pastes.release();
		}
		publishAuthFlow(ctx, flow);
	});
}

interface McpServerPayload {
	server?: string;
}

/**
 * Log a configured server in again. Planning probes the server first and fails
 * the request for a stdio server or one that connects without a login, before
 * anything is changed; the plan is committed only once the login succeeds, so
 * a cancelled login leaves the previous one signed in.
 */
const handleReauthMcpServer: ActionHandler<McpServerPayload | undefined> = async (ctx, payload) => {
	const name = payload?.server;
	if (!name) {
		failMcp(ctx, "INVALID_ARGUMENTS", "ReauthMcpServer requires a server parameter");
		return;
	}
	const manager = await mcpManagerFor(ctx);
	const entry = await findMcpServer(ctx, manager, name);
	if (!entry) {
		failMcp(ctx, "MCP_SERVER_NOT_FOUND", `MCP server '${name}' not found`);
		return;
	}
	if (entry.config.enabled === false) {
		failMcp(ctx, "MCP_SERVER_DISABLED", `MCP server '${name}' is disabled. Fix: enable it, then sign in again.`);
		return;
	}
	const authStorage = await ctx.authStorage();
	let plan: McpReauthPlan;
	try {
		plan = await planMcpReauth(preparerFor(manager), authStorage, entry.config);
	} catch (error) {
		failMcp(ctx, "MCP_REAUTH_UNAVAILABLE", `Cannot sign in to '${name}' again: ${errorMessage(error)}`);
		return;
	}
	const started = startMcpLogin(ctx, name, plan.flow, async result => {
		await commitMcpReauth(plan, result, authStorage, mcpUserConfigPath(ctx), name);
		await manager.disconnectServer(name);
		await connectConfiguredServer(ctx, manager, name);
		await publishMcpSections(ctx, manager);
	});
	if (!started) {
		failMcp(ctx, "AUTH_FLOW_IN_PROGRESS", authFlowBusyMessage(ctx));
		return;
	}
	ctx.reply.success();
};

export const mcpAuthActionHandlers: ActionHandlersMap = {
	ReauthMcpServer: handleReauthMcpServer as ActionHandler<never>,
};
