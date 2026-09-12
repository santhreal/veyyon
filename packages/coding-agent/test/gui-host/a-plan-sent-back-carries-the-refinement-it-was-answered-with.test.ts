/**
 * WHY: a plan sent back for revision told the agent only that a revision had
 * been asked for. The desktop offers "Refine" as soon as a draft exists, so the
 * refinement was typed, the plan was refused with `{ accepted: false }`, and
 * the text reached nothing: the agent read "Plan refinement requested. Update
 * the plan file, then call resolve again", rewrote the plan from the same
 * information it had the first time, and resubmitted it. The operator's own
 * words were the one input that could have changed the second draft.
 *
 * CLASS CLOSED: an answer the desktop gathers that does not reach the tool the
 * decision was raised from. The whole path is driven: a real host, a real
 * `AgentSession` in plan mode, the standing `resolve` handler, the interaction
 * ledger, `RespondToInteraction` over the socket, and the tool result the model
 * is given, read back off the session file. Both answers a refusal can carry
 * are covered -- a refinement and none -- and the accepted answer beside them,
 * so a change that routes one of the three through the wrong text goes red.
 *
 * NOT CAUGHT: a real provider request (`streamSimple` is stubbed at the
 * provider boundary); what the composer sends and which draft it gives up,
 * which `crates/veyyon-desktop-surface/tests/a-draft-the-host-took-as-an-answer-leaves-the-composer.rs`
 * owns; and the shapes the ledger rejects, which
 * `a-decision-reaches-the-desktop-and-its-answer-comes-back.test.ts` pins.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantMessage, Context, StopReason } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { PendingDecisions } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** The prompt whose turn submits the plan for review. */
const PLAN_PROMPT = "Submit the plan for review";
/** The plan the session's agent wrote, as the file the handler reads. */
const PLAN = "# A plan\n\nDo the work in one turn.\n";
/** What the operator asks for instead, typed into the composer under the card. */
const REFINEMENT = "Split step two into its own turn";
/** Frames a bounded read spends waiting for a card or an outcome. */
const FRAME_BUDGET = 400;
/** Reads a bounded poll of the session file spends waiting for a tool result. */
const DISK_READS = 200;

interface ActiveSessionSection {
	revision: number;
	value: { id: string };
}

interface InteractionsSection {
	session: string;
	pending: PendingDecisions;
}

function assistantMessage(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

/** A reply that submits the plan, which blocks the turn on a plan review. */
function planResolveStream(id: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const call = {
		type: "toolCall",
		id,
		name: "resolve",
		arguments: { action: "apply", reason: "the plan is ready for review" },
	} as const;
	const message = assistantMessage([call], "toolUse");
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
	});
	return stream;
}

/** A reply that finishes on its own. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage([{ type: "text", text }], "stop");
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

/**
 * The request that carries this suite's prompt into a turn, and not the title
 * generator's single `<user>`-wrapped copy of it.
 */
function isThePlanTurn(context: Context): boolean {
	const first = context.messages[0]?.content;
	if (context.messages.length === 1 && typeof first === "string" && first.startsWith("<user>")) return false;
	return JSON.stringify(context.messages).includes(PLAN_PROMPT);
}

describe("a plan sent back carries the refinement it was answered with", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** Plan submissions the stub has made, so the model stops asking. */
	let submissions: number;

	beforeEach(async () => {
		// `Settings` is process-wide and reads its file once, so plan mode has to
		// be re-read for this suite's own config rather than a previous one's.
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-plan-refine-"));
		sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });
		submissions = 0;
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			if (!isThePlanTurn(context)) return completedStream("Answered.");
			submissions += 1;
			// Two submissions at most: the one the operator sends back and the one
			// that follows it. A third would be the agent looping on a refusal,
			// which is what ends the turn instead of hanging the suite.
			return submissions <= 2
				? planResolveStream(`call-resolve-${submissions}`)
				: completedStream("Plan mode is over.");
		});
		await fs.writeFile(
			path.join(tempDir, "config.yml"),
			"modelRoles:\n  default: openai/gpt-4o-mini\nplan:\n  enabled: true\n  defaultOnStartup: true\n",
			"utf8",
		);
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		resetSettingsForTest();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** The session file that holds `session`, or null while it has not reached disk. */
	async function fileOf(session: string): Promise<string | null> {
		for (const file of await fs.readdir(sessionDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const full = path.join(sessionDir, file);
			const sm = await SessionManager.open(full, undefined, undefined, { suppressBreadcrumb: true });
			if (sm.getSessionId() === session) return full;
		}
		return null;
	}

	/**
	 * The directory `local://` resolves to for a session: a `local` directory in
	 * its artifacts directory. Polled, since the host writes the session file
	 * while it enters plan mode rather than when the session is created.
	 */
	async function localRootOf(session: string): Promise<string> {
		for (let read = 0; read < DISK_READS; read++) {
			const file = await fileOf(session);
			if (file) {
				const sm = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
				const dir = sm.getArtifactsDir();
				if (dir) return path.join(dir, "local");
			}
			await sleep(25);
		}
		throw new Error(`session ${session} never reached disk`);
	}

	/** A session in plan mode with the plan file its agent is about to submit. */
	async function sessionWithAPlan(): Promise<string> {
		const created = await client.request(1, { CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession emitted no ActiveSession");
		const localRoot = await localRootOf(session);
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "PLAN.md"), PLAN, "utf8");
		return session;
	}

	/** Read frames until the client is sent a plan card, and answer with its id. */
	async function planRaised(session: string): Promise<string> {
		for (let read = 0; read < FRAME_BUDGET; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			const section = (frame.Snapshot as { Interactions?: InteractionsSection } | undefined)?.Interactions;
			const plan = section?.pending.plans[0];
			if (plan) {
				expect(section?.session).toBe(session);
				// The card carries the plan the handler read off disk, so the
				// desktop is reviewing the plan and not a placeholder for it.
				expect(plan.markdown_plan).toBe(PLAN);
				return plan.id;
			}
		}
		throw new Error("no plan card ever reached the client");
	}

	/** The text of every `resolve` result the session has recorded, in order. */
	async function resolveResults(session: string, expected: number): Promise<string[]> {
		for (let read = 0; read < DISK_READS; read++) {
			const file = await fileOf(session);
			if (file) {
				const sm = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
				const results = sm
					.getEntries()
					.filter((entry: SessionEntry) => entry.type === "message")
					.map(entry => (entry as { message: { role: string; toolName?: string; content: unknown } }).message)
					.filter(message => message.role === "toolResult" && message.toolName === "resolve")
					.map(message => JSON.stringify(message.content));
				if (results.length >= expected) return results;
			}
			await sleep(25);
		}
		throw new Error(`the session never recorded ${expected} resolve results`);
	}

	test("a refusal tells the agent what to change, and the plan stays under review", async () => {
		const session = await sessionWithAPlan();
		client.send({ id: 2, action: { SubmitPrompt: { session, text: PLAN_PROMPT } } });

		const first = await planRaised(session);
		const sentBack = await client.request(3, {
			RespondToInteraction: { session, interaction_id: first, response: { accepted: false, feedback: REFINEMENT } },
		});
		expect(sentBack.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		// Plan mode survives a refusal, so the agent's next submission raises a
		// second card rather than running with the plan the operator refused.
		const second = await planRaised(session);
		expect(second).not.toBe(first);
		const accepted = await client.request(4, {
			RespondToInteraction: { session, interaction_id: second, response: { accepted: true } },
		});
		expect(accepted.outcome).toEqual({ RequestSucceeded: { request: 4 } });

		const [refused, approved] = await resolveResults(session, 2);
		expect(refused).toContain(REFINEMENT);
		expect(refused).toContain("Update the plan file");
		expect(approved).toContain("Plan approved at");
		expect(approved).not.toContain(REFINEMENT);
	});

	test("a refusal that carries no refinement says only to revise and resubmit", async () => {
		const session = await sessionWithAPlan();
		client.send({ id: 2, action: { SubmitPrompt: { session, text: PLAN_PROMPT } } });

		const first = await planRaised(session);
		await client.request(3, {
			RespondToInteraction: { session, interaction_id: first, response: { accepted: false } },
		});
		const second = await planRaised(session);
		await client.request(4, {
			RespondToInteraction: { session, interaction_id: second, response: { accepted: true } },
		});

		const [refused] = await resolveResults(session, 2);
		expect(refused).toContain("Plan refinement requested. Update the plan file");
		expect(refused).not.toContain("requested:");
	});
});
