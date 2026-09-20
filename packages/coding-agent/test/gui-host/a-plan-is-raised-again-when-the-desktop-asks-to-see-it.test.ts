/**
 * WHY: a plan decision was reachable from exactly one place — inside the
 * agent's `resolve` call. A card dismissed, a window attached after the card
 * was answered, or a plan the agent drafted without calling `resolve` left the
 * desktop with a plan on disk and no way to look at it, while the terminal's
 * `/plan-review` re-opened the same review at any time. `ReviewPlan` is that
 * command, so this suite drives it end to end over the real socket.
 *
 * THE CLASS THIS CLOSES: a review that reaches the window but leaves the
 * session somewhere the `resolve` route would not. Every outcome is asserted
 * against the session's own record rather than the reply: an approval exits
 * plan mode AND tells the agent the plan is approved, a refusal keeps plan
 * mode AND carries the refinement, a refusal with nothing typed runs no turn
 * at all. The three refusals to raise a card — no plan mode, no plan, a turn
 * in flight — are asserted by code, so a handler that quietly raises a card
 * anyway is red.
 *
 * WHAT IT DOES NOT CATCH: how the window draws the card, and which gesture
 * sends the action. The desktop crates own both; the protocol carrying
 * `ReviewPlan` and the host answering it are what this process can see.
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
import * as zod from "zod/v4";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, TestSocketClient } from "./test-client";

/**
 * The plan the session wrote, as the file the handler reads off disk.
 *
 * Named for its slug rather than `PLAN.md`, which is the address plan-mode
 * state carries until the agent names one: a plan the state does not name is
 * found only by the scan of the session's own plan files, which is the case
 * a default-named file would hide.
 */
const PLAN_FILE = "auth-plan.md";
const PLAN = "# A plan\n\nDo the work in one turn.\n";
/** What the operator types under the card when sending the plan back. */
const REFINEMENT = "Split step two into its own turn";
/** A prompt whose turn is held open, so a review meets a running turn. */
const HELD_PROMPT = "hold this turn open";
/** Frames a bounded read spends waiting for a card. */
const FRAME_BUDGET = 400;
/** Polls a bounded read spends waiting for the session file to say so. */
const DISK_READS = 200;
/** How long a turn that must NOT run is given to run anyway. */
const QUIET_MS = 750;

const activeSessionFrame = zod.object({
	Snapshot: zod.object({ ActiveSession: zod.object({ value: zod.object({ id: zod.string() }) }) }),
});

const planCardFrame = zod.object({
	Snapshot: zod.object({
		Interactions: zod.object({
			session: zod.string(),
			pending: zod.object({
				plans: zod.array(zod.object({ id: zod.string(), markdown_plan: zod.string() })),
			}),
		}),
	}),
});

const failureFrame = zod.object({
	RequestFailed: zod.object({ error: zod.object({ code: zod.string(), retryable: zod.boolean() }) }),
});

function assistantMessage(text: string, stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

/** Finish a reply that is open, which is also how a held turn is released. */
function finish(stream: AssistantMessageEventStream, text: string): void {
	const message = assistantMessage(text, "stop");
	stream.push({ type: "start", partial: { ...message, content: [] } });
	stream.push({
		type: "text_start",
		contentIndex: 0,
		partial: { ...message, content: [{ type: "text", text: "" }] },
	});
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
	stream.push({ type: "done", reason: "stop", message });
}

/** A reply that finishes on its own. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => finish(stream, text));
	return stream;
}

/**
 * One request's messages, or null for the title generator's.
 *
 * Naming a session runs its own request with the prompt wrapped in a single
 * `<user>` string, so it is not a turn and would otherwise be counted as one.
 */
function turnText(context: Context): string | null {
	const first = context.messages[0]?.content;
	if (context.messages.length === 1 && typeof first === "string" && first.startsWith("<user>")) return null;
	return JSON.stringify(context.messages);
}

describe("a plan is raised again when the desktop asks to see it", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** Every turn the session has run, in order, serialized. */
	let turns: string[];
	/** The reply still open, so a test can release the turn it holds. */
	let held: AssistantMessageEventStream | null;

	beforeEach(async () => {
		// `Settings` is process-wide and reads its file once, so plan mode has
		// to be re-read for this suite's config rather than a previous one's.
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-plan-review-"));
		sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });
		turns = [];
		held = null;
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			const text = turnText(context);
			if (!text) return completedStream("Named.");
			turns.push(text);
			if (!text.includes(HELD_PROMPT)) return completedStream("Answered.");
			held = new AssistantMessageEventStream();
			return held;
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
		if (held) finish(held, "Released.");
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
		const dir = await fs.readdir(sessionDir).catch(() => []);
		for (const file of dir) {
			if (!file.endsWith(".jsonl")) continue;
			const full = path.join(sessionDir, file);
			const sm = await SessionManager.open(full, undefined, undefined, { suppressBreadcrumb: true });
			if (sm.getSessionId() === session) return full;
		}
		return null;
	}

	/** Where `local://` resolves for a session, once the session is on disk. */
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

	/** The modes the session recorded, in the order it entered and left them. */
	async function recordedModes(session: string, expected: number): Promise<string[]> {
		for (let read = 0; read < DISK_READS; read++) {
			const modes = await modesNow(session);
			if (modes.length >= expected) return modes;
			await sleep(25);
		}
		throw new Error(`the session never recorded ${expected} mode changes`);
	}

	/** The modes recorded so far, without waiting for another. */
	async function modesNow(session: string): Promise<string[]> {
		const file = await fileOf(session);
		if (!file) return [];
		const sm = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
		return sm
			.getEntries()
			.filter((entry: SessionEntry) => entry.type === "mode_change")
			.map(entry => ("mode" in entry && typeof entry.mode === "string" ? entry.mode : ""));
	}

	/**
	 * A session with its plan written unless `withPlan` says not to.
	 *
	 * Plan mode is entered when the agent session is built, which is the first
	 * request that needs one rather than the creation, so the session is in
	 * plan mode from `ReviewPlan` itself onwards.
	 */
	async function planningSession(withPlan = true): Promise<string> {
		const created = await client.request(1, { CreateSession: {} });
		const header = created.frames.flatMap(frame => {
			const parsed = activeSessionFrame.safeParse(frame);
			return parsed.success ? [parsed.data.Snapshot.ActiveSession.value.id] : [];
		});
		const session = header.at(-1);
		if (!session) throw new Error("CreateSession emitted no ActiveSession");
		const localRoot = await localRootOf(session);
		await fs.mkdir(localRoot, { recursive: true });
		if (withPlan) await writePlan(localRoot, PLAN_FILE, PLAN, Date.now());
		return session;
	}

	/** Write one plan file with the modification time that orders it. */
	async function writePlan(localRoot: string, name: string, content: string, at: number): Promise<void> {
		const file = path.join(localRoot, name);
		await fs.writeFile(file, content, "utf8");
		await fs.utimes(file, new Date(at), new Date(at));
	}

	/** The plan card, taken from frames already read and then from the socket. */
	async function planRaised(session: string, seen: RequestFrame[] = [], expected = PLAN): Promise<string> {
		const cardIn = (frame: unknown): string | null => {
			const parsed = planCardFrame.safeParse(frame);
			if (!parsed.success) return null;
			const section = parsed.data.Snapshot.Interactions;
			const plan = section.pending.plans[0];
			if (!plan) return null;
			expect(section.session).toBe(session);
			// The card carries the plan the handler read off disk, so the
			// desktop is reviewing the plan and not a placeholder for it.
			expect(plan.markdown_plan).toBe(expected);
			return plan.id;
		};
		for (const frame of seen) {
			const id = cardIn(frame);
			if (id) return id;
		}
		for (let read = 0; read < FRAME_BUDGET; read++) {
			const id = cardIn(await client.nextFrame());
			if (id) return id;
		}
		throw new Error("no plan card ever reached the client");
	}

	/** The failure a request was refused with, or null when it succeeded. */
	function refusal(outcome: RequestFrame): { code: string; retryable: boolean } | null {
		const parsed = failureFrame.safeParse(outcome);
		return parsed.success ? parsed.data.RequestFailed.error : null;
	}

	/** Wait for a turn carrying `marker`, bounded, and report whether one ran. */
	async function turnCarrying(marker: string): Promise<boolean> {
		for (let read = 0; read < DISK_READS; read++) {
			if (turns.some(turn => turn.includes(marker))) return true;
			await sleep(25);
		}
		return false;
	}

	test("approving the plan leaves plan mode and tells the agent to implement it", async () => {
		const session = await planningSession();

		const asked = await client.request(2, { ReviewPlan: { session } });
		expect(asked.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const card = await planRaised(session, asked.frames);
		const approved = await client.request(3, {
			RespondToInteraction: { session, interaction_id: card, response: { accepted: true } },
		});
		expect(approved.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		// The session leaves plan mode, which is what gives the tools back, and
		// the agent is told so in the turn that follows — a mode left with no
		// turn behind it is a session sitting on an approved plan doing nothing.
		expect(await recordedModes(session, 2)).toEqual(["plan", "none"]);
		expect(await turnCarrying("Plan approved at")).toBe(true);
		expect(await turnCarrying(PLAN_FILE)).toBe(true);
	}, 30000);

	test("the plan raised is the newest the session wrote, not the default address", async () => {
		const session = await planningSession();
		const stale = "# An older plan\n\nSuperseded.\n";
		// `local://PLAN.md` is the address plan-mode state carries until the
		// agent names one, so a handler reading state alone reviews this file
		// and never the plan the session actually wrote.
		await writePlan(await localRootOf(session), "PLAN.md", stale, Date.now() - 60_000);

		const asked = await client.request(2, { ReviewPlan: { session } });
		expect(asked.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		await planRaised(session, asked.frames, PLAN);
	}, 30000);

	test("sending the plan back carries the refinement and keeps plan mode on", async () => {
		const session = await planningSession();

		const asked = await client.request(2, { ReviewPlan: { session } });
		const card = await planRaised(session, asked.frames);
		const sentBack = await client.request(3, {
			RespondToInteraction: {
				session,
				interaction_id: card,
				response: { accepted: false, feedback: REFINEMENT },
			},
		});
		expect(sentBack.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		expect(await turnCarrying(REFINEMENT)).toBe(true);
		expect(await turnCarrying("Update the plan file")).toBe(true);
		// Plan mode survives a refusal: the agent revises under the same
		// restriction rather than gaining its tools back on a refused plan.
		expect(await modesNow(session)).toEqual(["plan"]);
	}, 30000);

	test("a refusal with nothing typed runs no turn", async () => {
		const session = await planningSession();

		const asked = await client.request(2, { ReviewPlan: { session } });
		const card = await planRaised(session, asked.frames);
		const before = turns.length;
		await client.request(3, {
			RespondToInteraction: { session, interaction_id: card, response: { accepted: false } },
		});

		// Nothing to send, so nothing is sent. A turn here would spend a
		// request telling the agent only that somebody closed a card.
		await sleep(QUIET_MS);
		expect(turns.length).toBe(before);
		expect(await modesNow(session)).toEqual(["plan"]);
	}, 30000);

	test("a session with no plan written is told so instead of being shown an empty card", async () => {
		const session = await planningSession(false);

		const asked = await client.request(2, { ReviewPlan: { session } });
		expect(refusal(asked.outcome)?.code).toBe("NO_PLAN");
		const card = asked.frames.some(frame => {
			const parsed = planCardFrame.safeParse(frame);
			return parsed.success && parsed.data.Snapshot.Interactions.pending.plans.length > 0;
		});
		expect(card).toBe(false);
	}, 30000);

	test("a session that is not planning has no plan to review", async () => {
		const session = await planningSession();
		const left = await client.request(2, { SetSessionMode: { session, mode: "none" } });
		expect(left.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const asked = await client.request(3, { ReviewPlan: { session } });
		expect(refusal(asked.outcome)?.code).toBe("NOT_IN_PLAN_MODE");
	}, 30000);

	test("a review asked for under a running turn waits for the turn rather than competing with it", async () => {
		const session = await planningSession();
		client.send({ id: 2, action: { SubmitPrompt: { session, text: HELD_PROMPT } } });
		expect(await turnCarrying(HELD_PROMPT)).toBe(true);

		// The card the agent's own `resolve` raises and one raised beside it
		// answer the same plan to two different places, so the review is
		// refused while a turn is in flight — retryable, since the turn ends.
		let refused: { code: string; retryable: boolean } | null = null;
		for (let attempt = 0; attempt < DISK_READS && !refused; attempt++) {
			const asked = await client.request(100 + attempt, { ReviewPlan: { session } });
			refused = refusal(asked.outcome);
			if (!refused) throw new Error("the review was raised while the turn was still running");
			if (refused.code !== "TURN_IN_PROGRESS") throw new Error(`refused with ${refused.code}`);
		}
		expect(refused).toEqual({ code: "TURN_IN_PROGRESS", retryable: true });

		const open = held;
		if (!open) throw new Error("the held turn never reached the stub");
		held = null;
		finish(open, "Answered.");

		// And once it ends the same ask is answered, so the refusal is a wait
		// and not a dead end.
		for (let attempt = 0; attempt < DISK_READS; attempt++) {
			const asked = await client.request(200 + attempt, { ReviewPlan: { session } });
			if (!refusal(asked.outcome)) {
				await planRaised(session, asked.frames);
				return;
			}
			await sleep(25);
		}
		throw new Error("the review was never raised after the turn ended");
	}, 30000);
});
