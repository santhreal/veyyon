/**
 * A GitLab Duo turn that pauses while replaying buffered frames resumes, on the next turn, from every frame
 * it had not handled yet.
 *
 * WHY THIS SUITE EXISTS. Duo checkpoints are full `ui_chat_log` snapshots, so one frame can hold several
 * server-side tool boundaries. The first boundary pauses the turn and buffers the frame on the session; the
 * next turn replays it and pauses again at the second boundary, re-buffering the frame. The replay then
 * released its own pause flag for every result that ended it, a pause included, so the session read as
 * unpaused: the next turn found no buffer to replay and the steps after the second boundary were lost,
 * together with every frame the socket delivered between the two turns.
 *
 * THE CLASS IT CLOSES. Every result that can end a replay, swept from `REPLAY_ENDINGS`: only a pause leaves
 * the session paused and holding frames, and every other result releases it with an empty buffer, so a live
 * frame is handled directly and no stale frame waits for a later pause. The order of
 * the frames a replay feeds: replayed frames first, then the frames that arrived while it ran, in arrival
 * order, both when the replay drains and when a pause re-buffers them.
 *
 * WHAT IT DOES NOT CATCH. The result union is a private type, so a new member is not swept until it is
 * added to `REPLAY_ENDINGS`. A replay ended by an external settle (abort, idle timeout) while a frame is
 * in flight.
 */
import { describe, expect, it } from "bun:test";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import {
	buildGitLabDuoWorkflowStartRequest,
	type GitLabDuoWorkflowActiveSession,
	type GitLabDuoWorkflowStreamState,
	type GitLabDuoWorkflowWebSocketFactory,
	type GitLabDuoWorkflowWebSocketLike,
	runGitLabDuoWorkflowSocket,
	streamGitLabDuoWorkflow,
} from "@veyyon/ai/providers/gitlab-duo-workflow";
import type { AssistantMessage, Context, FetchImpl, Model, ProviderSessionState } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
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

const TOOL = { message_type: "tool", content: "tool ran" };

function agent(id: string, content: string): Record<string, string> {
	return { message_type: "agent", message_id: id, content };
}

function checkpointFrame(status: string, chatLog: readonly object[]): string {
	return JSON.stringify({
		newCheckpoint: { status, checkpoint: JSON.stringify({ channel_values: { ui_chat_log: chatLog } }) },
	});
}

const TOOL_CALL_FRAME = JSON.stringify({
	requestID: "req-1",
	runMCPTool: { name: "mcp__veyyon__read", args: JSON.stringify({ path: "README.md" }) },
});

function socketDouble(): GitLabDuoWorkflowWebSocketLike {
	return { onopen: null, onmessage: null, onerror: null, onclose: null, send() {}, close() {} };
}

function deliver(socket: GitLabDuoWorkflowWebSocketLike, data: string): void {
	socket.onmessage?.(new MessageEvent("message", { data }));
}

function texts(message: AssistantMessage): string[] {
	return message.content.flatMap(block => (block.type === "text" ? [block.text] : []));
}

function emptyOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "gitlab-duo-agent",
		provider: "gitlab-duo-agent",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

interface Replay {
	socket: GitLabDuoWorkflowWebSocketLike;
	active: GitLabDuoWorkflowActiveSession;
	state: GitLabDuoWorkflowStreamState;
	run: Promise<string>;
}

/** Starts a socket run that replays `frames` on a session paused at a previous turn. */
function replay(frames: readonly string[], prepare?: (replay: Omit<Replay, "run">) => void): Replay {
	const socket = socketDouble();
	const startPayload = buildGitLabDuoWorkflowStartRequest("workflow-1", model, context);
	const active: GitLabDuoWorkflowActiveSession = { workflowId: "workflow-1", startPayload, ws: socket };
	const state: GitLabDuoWorkflowStreamState = {
		stream: new AssistantMessageEventStream(),
		output: emptyOutput(),
		started: true,
		providerSessionState: { active, close() {} },
	};
	prepare?.({ socket, active, state });
	const run = runGitLabDuoWorkflowSocket(socket, startPayload, state, { apiKey: "redacted" }, undefined, frames);
	return { socket, active, state, run };
}

/** A frame that ends a replay with each result, and the session state that result needs before it. */
const REPLAY_ENDINGS: Record<string, { frame: string; prepare?: (replay: Omit<Replay, "run">) => void }> = {
	pause: { frame: checkpointFrame("RUNNING", [agent("a", "First step."), TOOL]) },
	action: { frame: TOOL_CALL_FRAME },
	terminal: { frame: checkpointFrame("FINISHED", [agent("a", "Done.")]) },
	approval: { frame: JSON.stringify({ status: "TOOL_CALL_APPROVAL_REQUIRED" }) },
	step_limit: {
		frame: JSON.stringify({
			status: "FAILED",
			error: "The workflow reached its maximum step limit and could not complete.",
		}),
	},
	retryable_error: {
		frame: JSON.stringify({
			status: "FAILED",
			error: "There was an error processing your request in the Duo Agent Platform, please contact support if the issue persists.",
		}),
	},
	stalled: {
		frame: TOOL_CALL_FRAME,
		// The previous tool-call boundary saw a checkpoint of the same length, so the workflow did not advance.
		prepare: ({ active, state }) => {
			active.lastToolBoundaryContentLength = 120;
			state.lastCheckpointContentLength = 120;
		},
	},
};

describe("a GitLab Duo turn paused while replaying resumes from what it buffered", () => {
	it("replays every step after the next boundary of a snapshot, with the frames that arrived between turns", async () => {
		const snapshot = checkpointFrame("RUNNING", [
			agent("a", "First step."),
			TOOL,
			agent("b", "Second step."),
			TOOL,
			agent("c", "Third step."),
		]);
		const later = checkpointFrame("FINISHED", [
			agent("a", "First step."),
			TOOL,
			agent("b", "Second step."),
			TOOL,
			agent("c", "Third step."),
			agent("d", "Fourth step."),
		]);
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
			if (url.includes("/api/v4/ai/duo_workflows/workflows") && method === "POST") {
				return Response.json({ id: "workflow-1" });
			}
			return Response.json({});
		};
		const sockets: GitLabDuoWorkflowWebSocketLike[] = [];
		const webSocketFactory: GitLabDuoWorkflowWebSocketFactory = () => {
			const socket = socketDouble();
			const first = sockets.length === 0;
			sockets.push(socket);
			queueMicrotask(() => {
				socket.onopen?.(new Event("open"));
				// A later socket means the session lost its buffered frames and the turn started over.
				deliver(socket, first ? snapshot : checkpointFrame("FINISHED", []));
			});
			return socket;
		};
		const sessions = new Map<string, ProviderSessionState>();
		const turn = () =>
			streamGitLabDuoWorkflow(model, context, {
				apiKey: "key-replay-pause",
				rootNamespaceId: "gid://gitlab/Group/1",
				fetch: fetchImpl,
				webSocketFactory,
				providerSessionState: sessions,
				sessionId: "session-replay-pause",
			}).result();

		const first = await turn();
		expect(texts(first)).toEqual(["First step."]);
		expect(first.stopDetails?.type).toBe("pause_turn");

		const second = await turn();
		expect(texts(second)).toEqual(["Second step."]);
		expect(second.stopDetails?.type).toBe("pause_turn");

		// The server keeps streaming while the paused turn is handed back.
		deliver(sockets[0], later);

		const third = await turn();
		expect(texts(third)).toEqual(["Third step.", "Fourth step."]);
		expect(third.stopDetails?.type).toBeUndefined();
		expect(sockets.length).toBe(1);
	});

	it("handles the frames that arrived during a replay after the replayed ones, then handles live frames directly", async () => {
		const { socket, active, state, run } = replay([
			checkpointFrame("RUNNING", [agent("a", "One.")]),
			checkpointFrame("RUNNING", [agent("b", "Two.")]),
		]);
		// The replay has fed its first frame and yields; these arrive while it runs.
		deliver(socket, checkpointFrame("RUNNING", [agent("c", "Three.")]));
		deliver(socket, checkpointFrame("RUNNING", [agent("d", "Four.")]));
		await nextEventLoopTurn();

		expect(active.paused).toBe(false);
		expect(active.pauseBuffer ?? []).toEqual([]);
		deliver(socket, checkpointFrame("FINISHED", [agent("e", "Five.")]));

		expect(await run).toBe("terminal");
		expect(texts(state.output)).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
	});

	it("re-buffers the unreplayed frames ahead of the ones that arrived during the replay when it pauses", async () => {
		const pause = REPLAY_ENDINGS.pause.frame;
		const unreplayed = checkpointFrame("RUNNING", [agent("b", "Unreplayed.")]);
		const arrived = checkpointFrame("RUNNING", [agent("c", "Arrived.")]);
		const { socket, active, run } = replay([pause, unreplayed]);
		deliver(socket, arrived);

		expect(await run).toBe("pause");
		expect(active.paused).toBe(true);
		expect(active.pauseBuffer).toEqual([pause, unreplayed, arrived]);
	});

	it("re-buffers each frame that arrived during the replay once when one of them pauses it", async () => {
		const pause = checkpointFrame("RUNNING", [agent("b", "Two."), TOOL]);
		const after = checkpointFrame("RUNNING", [agent("c", "Three.")]);
		const { socket, active, run } = replay([checkpointFrame("RUNNING", [agent("a", "One.")])]);
		deliver(socket, pause);
		deliver(socket, after);

		expect(await run).toBe("pause");
		expect(active.paused).toBe(true);
		expect(active.pauseBuffer).toEqual([pause, after]);
	});

	for (const [result, ending] of Object.entries(REPLAY_ENDINGS)) {
		it(`holds frames for the next turn after a replay that ends on ${result} only when it paused`, async () => {
			const arrived = checkpointFrame("RUNNING", [agent("z", "Arrived.")]);
			const { socket, active, run } = replay([ending.frame], ending.prepare);
			deliver(socket, arrived);
			expect(await run).toBe(result);
			const paused = result === "pause";
			expect(active.paused).toBe(paused);
			expect(active.pauseBuffer).toEqual(paused ? [ending.frame, arrived] : []);
		});
	}

	it("settles the run with the error of a replayed frame that cannot be read", async () => {
		const { run } = replay([JSON.stringify({ runMCPTool: { name: "mcp__veyyon__read", args: "{}" } })]);
		await expect(run).rejects.toThrow('GitLab Duo Workflow action "runMCPTool" missing requestID');
	});
});
