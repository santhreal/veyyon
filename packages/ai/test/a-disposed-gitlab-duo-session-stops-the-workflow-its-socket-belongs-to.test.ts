/**
 * Disposing a GitLab Duo session stops the workflow its live socket belongs to.
 *
 * WHY THIS SUITE EXISTS. A turn that restarts on a fresh workflow stops the workflow it started on
 * and creates a new one. When the new socket settles on a tool call, the session keeps that socket
 * live for the resume, and disposing the session sends the stop PATCH for the workflow behind it.
 * A dispose that stops the workflow the turn started on instead leaves the live one running
 * server-side, still holding the tool call it is waiting on.
 *
 * THE CLASS IT CLOSES. Every socket result the restart loop recovers from, swept from
 * `GITLAB_DUO_WORKFLOW_RESTART_LIMITS`: a new recoverable result fails this suite until it has a
 * trigger here or is added to the unreachable list.
 *
 * WHAT IT DOES NOT CATCH. A stall restart: a fresh attempt's socket has no earlier tool-call boundary
 * to compare against and settles on its first one, so the loop never receives "stalled" and that
 * member is pinned as the only one without a trigger. A dispose that races a turn still in flight.
 */
import { describe, expect, it } from "bun:test";
import {
	GITLAB_DUO_WORKFLOW_RESTART_LIMITS,
	type GitLabDuoWorkflowWebSocketFactory,
	type GitLabDuoWorkflowWebSocketLike,
	streamGitLabDuoWorkflow,
} from "@veyyon/ai/providers/gitlab-duo-workflow";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const model: Model<"gitlab-duo-agent"> = buildModel({
	id: "claude_sonnet_4_6_vertex",
	name: "claude_sonnet_4_6_vertex",
	api: "gitlab-duo-agent",
	provider: "gitlab-duo-agent",
	baseUrl: "https://gitlab.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: null,
});

const context: Context = { messages: [{ role: "user", content: "Read the README.", timestamp: 1 }] };

function deliver(socket: GitLabDuoWorkflowWebSocketLike, data: unknown): void {
	socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
}

/** What the first socket does to make the loop restart on a fresh workflow, per recoverable result. */
const RESTART_TRIGGERS: Record<string, (socket: GitLabDuoWorkflowWebSocketLike) => void> = {
	// Silence past the idle window.
	timeout: () => {},
	step_limit: socket =>
		deliver(socket, {
			status: "FAILED",
			error: "The workflow reached its maximum step limit and could not complete.",
		}),
	retryable_error: socket =>
		deliver(socket, {
			status: "FAILED",
			error: "There was an error processing your request in the Duo Agent Platform, please contact support if the issue persists.",
		}),
};

/** Recoverable results the restart loop cannot receive from a fresh attempt. */
const UNREACHABLE = ["stalled"];

/** The restarted socket settles on a tool call, which keeps it live on the session. */
function settleOnToolCall(socket: GitLabDuoWorkflowWebSocketLike): void {
	deliver(socket, {
		newCheckpoint: {
			status: "RUNNING",
			checkpoint: JSON.stringify({
				channel_values: { ui_chat_log: [{ message_type: "agent", message_id: "a", content: "Reading" }] },
			}),
		},
	});
	deliver(socket, {
		requestID: "req-1",
		runMCPTool: { name: "mcp__veyyon__read", args: JSON.stringify({ path: "README.md" }) },
	});
}

interface Turn {
	/** Workflow ids the stop PATCHes named, in order. */
	stops: string[];
	/** Settles once `count` stops have been sent. */
	stopsReach(count: number): Promise<void>;
	sessions: Map<string, ProviderSessionState>;
	stopReason: string;
}

async function runRestartedTurn(
	cause: string,
	trigger: (socket: GitLabDuoWorkflowWebSocketLike) => void,
): Promise<Turn> {
	const stops: string[] = [];
	const waiters: { count: number; resolve: () => void }[] = [];
	let creates = 0;
	const fetchImpl: FetchImpl = async (input, init) => {
		const url = String(input);
		const method = (init?.method ?? "GET").toUpperCase();
		if (url.includes("/api/graphql")) {
			return Response.json({
				data: {
					aiChatAvailableModels: {
						defaultModel: { name: "Claude", ref: "claude_sonnet_4_6_vertex" },
						selectableModels: [],
						pinnedModel: null,
					},
				},
			});
		}
		if (url.includes("/api/v4/ai/duo_workflows/direct_access")) {
			return Response.json({ gitlab_rails: { token: "rails-token" } });
		}
		if (url.includes("/api/v4/ai/duo_workflows/workflows/") && method === "PATCH") {
			stops.push(url.slice(url.lastIndexOf("/") + 1));
			for (const waiter of waiters) if (stops.length >= waiter.count) waiter.resolve();
			return Response.json({});
		}
		if (url.includes("/api/v4/ai/duo_workflows/workflows") && method === "POST") {
			creates++;
			return Response.json({ id: `workflow-${creates}` });
		}
		return Response.json({}, { status: 404 });
	};
	let opened = 0;
	const webSocketFactory: GitLabDuoWorkflowWebSocketFactory = () => {
		const attempt = opened++;
		const socket: GitLabDuoWorkflowWebSocketLike = {
			onopen: null,
			onmessage: null,
			onerror: null,
			onclose: null,
			send() {},
			close() {},
		};
		queueMicrotask(() => {
			socket.onopen?.(new Event("open"));
			if (attempt === 0) trigger(socket);
			else settleOnToolCall(socket);
		});
		return socket;
	};
	const sessions = new Map<string, ProviderSessionState>();
	const result = await streamGitLabDuoWorkflow(model, context, {
		apiKey: `key-dispose-${cause}`,
		rootNamespaceId: "gid://gitlab/Group/1",
		fetch: fetchImpl,
		webSocketFactory,
		providerSessionState: sessions,
		sessionId: `session-${cause}`,
		idleTimeoutMs: 20,
	}).result();
	return {
		stops,
		stopsReach(count) {
			if (stops.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			return promise;
		},
		sessions,
		stopReason: result.stopReason,
	};
}

describe("disposing a GitLab Duo session stops the workflow its live socket belongs to", () => {
	it("has a restart trigger for every recoverable socket result the loop can receive", () => {
		const recoverable = Object.keys(GITLAB_DUO_WORKFLOW_RESTART_LIMITS).sort();
		expect(recoverable.filter(result => !(result in RESTART_TRIGGERS))).toEqual(UNREACHABLE);
		expect(Object.keys(RESTART_TRIGGERS).filter(result => !recoverable.includes(result))).toEqual([]);
	});

	for (const [cause, trigger] of Object.entries(RESTART_TRIGGERS)) {
		it(`stops the restarted workflow after a ${cause} restart`, async () => {
			const turn = await runRestartedTurn(cause, trigger);
			expect(turn.stopReason).toBe("toolUse");
			// The restart stopped the workflow the turn started on; the restarted one is live.
			expect(turn.stops).toEqual(["workflow-1"]);

			for (const session of turn.sessions.values()) session.close();
			await turn.stopsReach(2);
			expect(turn.stops).toEqual(["workflow-1", "workflow-2"]);
		});
	}
});
