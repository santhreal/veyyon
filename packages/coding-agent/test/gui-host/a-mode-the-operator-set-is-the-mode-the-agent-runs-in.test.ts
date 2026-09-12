/**
 * WHY: plan mode was reachable on a desktop-attached session in exactly one
 * way -- the host entered it by itself, at launch, when `plan.defaultOnStartup`
 * was set. Nothing an operator could press entered it afterwards and nothing
 * left it, so a session that started unrestricted stayed unrestricted for its
 * whole life and a session that started in plan mode could only escape by
 * having its plan accepted. `SetSessionMode` is the action that closes that,
 * and this suite is the host's half of it: the mode reaches the agent's tool
 * set, reaches the session file, and comes back on the header the desktop
 * draws its chip from.
 *
 * CLASS CLOSED: a mode change accepted and not applied, or applied and not
 * stated. Every accepted mode is swept from `SESSION_MODES`-shaped requests
 * built here, and each one is asserted on three surfaces at once: the active
 * tool set, the `mode_change` the session recorded, and the `mode` on the
 * `ActiveSession` header. A request the host takes and drops fails, as does one
 * it applies without restating the header, which is what would leave the chip
 * stale. Refusals are swept the same way, by exact message.
 *
 * What plan mode DOES is asserted on the turn the agent then runs: the session
 * prepends the plan-mode instruction to a turn in plan mode, which is how the
 * agent is told the working tree is read-only, and prepends nothing to a turn
 * out of it. That is the only place the mode's effect on the agent appears
 * short of running a real model, and reading it off the provider request is
 * what makes this a behavioural assertion rather than a state one. The tool
 * NAME set is deliberately not the assertion: `resolve` is in the default set
 * already, so a mode that reached nothing would pass such a check.
 *
 * NOT CAUGHT: the desktop's own half -- that the palette offers both rows and
 * that the header's mode reaches the composer's chip -- is
 * `crates/veyyon-desktop/tests/a-mode-the-session-runs-in-is-reachable-and-stated.rs`.
 * It also says nothing about `goal` or `vibe`: those are entered by the tools
 * that own them, and a request naming one is refused here rather than honoured.
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
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** Reads a bounded poll of the session file spends waiting for an entry. */
const POLLS = 120;

interface ActiveSessionSection {
	revision: number;
	value: { id: string; mode: string };
}

interface Failure {
	RequestFailed?: { error: { code: string; message: string; scope: string; retryable: boolean } };
}

/** The plan-mode instruction's first sentence, as the agent receives it. */
const PLAN_INSTRUCTION = "Plan mode is active.";

/**
 * One turn's messages, each serialized, or null for the title generator's.
 *
 * Naming a session runs its own request against the same model, with the
 * prompt wrapped in a single `<user>` string and none of the turn's own
 * messages, so it carries no mode and would otherwise be read as a turn that
 * was told nothing.
 */
function observe(context: Context): string[] | null {
	const first = context.messages[0]?.content;
	if (context.messages.length === 1 && typeof first === "string" && first.startsWith("<user>")) return null;
	return context.messages.map(message => JSON.stringify(message));
}

/**
 * Whether the agent was told it is in plan mode FOR the turn `marker` names.
 *
 * Message-by-message rather than over the whole request, because the
 * instruction is a message in the conversation: once one turn has carried it,
 * every later request carries that copy in its history. A turn is in plan mode
 * when the instruction sits immediately in front of its own prompt, which is
 * where the session puts it, so a mode that was left still reads as left.
 */
function toldPlanMode(messages: string[], marker: string): boolean {
	const at = messages.findLastIndex(message => message.includes(marker));
	return at > 0 && messages[at - 1]!.includes(PLAN_INSTRUCTION);
}

/**
 * Run one turn with a prompt naming it, and report whether the agent was told
 * it is in plan mode for that turn.
 *
 * Two waits, both real: `SubmitPrompt` is refused while the previous turn is
 * still in flight, since a prompt sent during a turn steers or queues rather
 * than starting one, so the submission is retried until the session is idle;
 * and it settles when the session ACCEPTS the prompt rather than when the turn
 * ends, so the turn is then found by the prompt inside it.
 */
async function planTurn(
	client: TestSocketClient,
	turns: string[][],
	session: string,
	request: number,
): Promise<boolean> {
	const marker = `turn ${request}`;
	for (let attempt = 0; ; attempt++) {
		if (attempt >= POLLS) throw new Error(`the session never became idle for \`${marker}\``);
		const reply = await client.request(request * 100 + attempt, { SubmitPrompt: { session, text: marker } });
		const failure = (reply.outcome as Failure).RequestFailed;
		if (!failure) break;
		if (failure.error.code !== "TURN_IN_PROGRESS") {
			throw new Error(`\`${marker}\` was refused: ${failure.error.code} ${failure.error.message}`);
		}
		await sleep(25);
	}
	for (let read = 0; read < POLLS; read++) {
		const turn = turns.find(messages => messages.some(message => message.includes(marker)));
		if (turn) return toldPlanMode(turn, marker);
		await sleep(25);
	}
	throw new Error(`\`${marker}\` ran no turn`);
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		model: "gpt-4o-mini",
		provider: "openai",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as StopReason,
		timestamp: Date.now(),
	};
}

/** A reply that finishes on its own. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("a mode the operator set is the mode the agent runs in", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** Every turn the session has run, in order. */
	let turns: string[][];

	beforeEach(async () => {
		// `Settings` is process-wide and reads its file once, so plan mode has to
		// be re-read for this suite's own config rather than a previous one's.
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-session-mode-"));
		sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });
		turns = [];
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			const observed = observe(context);
			if (observed) turns.push(observed);
			return completedStream("Answered.");
		});
		// Plan mode enabled and NOT on at startup: the session opens
		// unrestricted, which is the state an operator's `/plan` acts on.
		await fs.writeFile(
			path.join(tempDir, "config.yml"),
			"modelRoles:\n  default: openai/gpt-4o-mini\nplan:\n  enabled: true\n  defaultOnStartup: false\n",
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

	/** The modes the session recorded, in the order it entered and left them. */
	async function recordedModes(session: string, expected: number): Promise<string[]> {
		for (let read = 0; read < POLLS; read++) {
			const file = await fileOf(session);
			if (file) {
				const sm = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
				const modes = sm
					.getEntries()
					.filter((entry: SessionEntry) => entry.type === "mode_change")
					.map(entry => (entry as { mode: string }).mode);
				if (modes.length >= expected) return modes;
			}
			await sleep(25);
		}
		throw new Error(`the session never recorded ${expected} mode changes`);
	}

	/** An open session the host has built an agent for. */
	async function openSession(): Promise<string> {
		const created = await client.request(1, { CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession emitted no ActiveSession");
		return session;
	}

	/** The last header a request's frames restated, which the chip is drawn from. */
	function activeSession(frames: RequestFrame[]): ActiveSessionSection | undefined {
		return snapshotSections<ActiveSessionSection>(frames, "ActiveSession").at(-1);
	}

	/** This suite's turn driver, bound to its own client and observations. */
	function turn(session: string, request: number): Promise<boolean> {
		return planTurn(client, turns, session, request);
	}

	test("entering plan mode tells the agent so and states the mode on the header", async () => {
		const session = await openSession();
		expect(await turn(session, 2)).toBe(false);

		const entered = await client.request(3, { SetSessionMode: { session, mode: "plan" } });
		expect(entered.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		// The header is what the chip is drawn from, so a mode applied without
		// one restated is a mode the operator cannot see.
		expect(activeSession(entered.frames)?.value.mode).toBe("plan");
		expect(await recordedModes(session, 1)).toEqual(["plan"]);
		// And the turn after it runs under the restriction, which is the whole
		// point of the mode.
		expect(await turn(session, 4)).toBe(true);
	});

	test("leaving plan mode returns the session to running unrestricted", async () => {
		const session = await openSession();
		await client.request(2, { SetSessionMode: { session, mode: "plan" } });
		expect(await turn(session, 3)).toBe(true);

		const left = await client.request(4, { SetSessionMode: { session, mode: "none" } });
		expect(left.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		expect(activeSession(left.frames)?.value.mode).toBe("none");
		expect(await recordedModes(session, 2)).toEqual(["plan", "none"]);

		// A mode that outlives its exit is the defect this half catches: the
		// agent would keep being told the working tree is read-only.
		expect(await turn(session, 5)).toBe(false);
	});

	test("a mode the operator does not own, and a name that is not a mode, are refused", async () => {
		const session = await openSession();

		// Swept together because they are one decision: the action carries a
		// name, and every name outside the pair the operator owns is refused
		// rather than half-applied. `goal` and `vibe` are real modes the host
		// writes, which is exactly why a request naming one has to be refused
		// here instead of reaching `enterPlanMode`.
		let request = 2;
		for (const mode of ["goal", "vibe", "plan_paused", "PLAN", "", "off"]) {
			const refused = await client.request(request, { SetSessionMode: { session, mode } });
			request += 1;
			const failure = refused.outcome as Failure;
			expect(failure.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
			expect(failure.RequestFailed?.error.message).toBe("SetSessionMode mode must be one of plan, none");
		}

		expect(await turn(session, request)).toBe(false);
	});

	test("leaving a mode the session is not in is reported and changes nothing", async () => {
		const session = await openSession();

		const refused = await client.request(2, { SetSessionMode: { session, mode: "none" } });
		const failure = refused.outcome as Failure;
		expect(failure.RequestFailed?.error.code).toBe("NOT_IN_MODE");
		expect(failure.RequestFailed?.error.scope).toBe("Session");

		expect(await turn(session, 3)).toBe(false);
		// No mode change was recorded, so a resumed session does not come back
		// claiming it left a mode it was never in.
		const file = await fileOf(session);
		const sm = file ? await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true }) : null;
		expect(sm?.getEntries().filter((entry: SessionEntry) => entry.type === "mode_change")).toEqual([]);
	});

	test("entering plan mode twice is the mode it already is, not a second entry", async () => {
		const session = await openSession();
		await client.request(2, { SetSessionMode: { session, mode: "plan" } });

		const again = await client.request(3, { SetSessionMode: { session, mode: "plan" } });
		expect(again.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		// One `mode_change`, not two. A second entry would capture the plan
		// tool set as the set to restore, so leaving would hand the agent
		// plan mode's own tools back instead of the ones the session had.
		await sleep(100);
		expect(await recordedModes(session, 1)).toEqual(["plan"]);
		await client.request(4, { SetSessionMode: { session, mode: "none" } });
		expect(await turn(session, 5)).toBe(false);
	});

	test("a mode change under a running turn is refused, and lands once the turn ends", async () => {
		const session = await openSession();
		const held = new AssistantMessageEventStream();
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			const observed = observe(context);
			if (!observed) return completedStream("Named.");
			turns.push(observed);
			const opening = assistantMessage("working on it");
			held.push({ type: "start", partial: { ...opening, content: [] } });
			held.push({ type: "text_delta", contentIndex: 0, delta: "working on it", partial: opening });
			return held;
		});
		await client.request(2, { SubmitPrompt: { session, text: "hold the turn open" } });
		for (let read = 0; read < POLLS && turns.length === 0; read++) await sleep(25);
		expect(turns.length).toBe(1);

		// Entering a mode swaps the tool set the running request is already
		// being answered with, so the mode waits for the turn rather than
		// changing what the agent may call halfway through it.
		const refused = await client.request(3, { SetSessionMode: { session, mode: "plan" } });
		const failure = refused.outcome as Failure;
		expect(failure.RequestFailed?.error.code).toBe("TURN_IN_PROGRESS");
		expect(failure.RequestFailed?.error.retryable).toBe(true);

		held.end(assistantMessage("Answered."));
		let entered = await client.request(4, { SetSessionMode: { session, mode: "plan" } });
		for (let read = 0; read < POLLS && (entered.outcome as Failure).RequestFailed; read++) {
			await sleep(25);
			entered = await client.request(4, { SetSessionMode: { session, mode: "plan" } });
		}
		expect(entered.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		// One entry: the refusal recorded nothing of its own.
		expect(await recordedModes(session, 1)).toEqual(["plan"]);
	});
});

describe("plan mode disabled in settings cannot be entered from the desktop", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let turns: string[][];

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-mode-off-"));
		const sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });
		turns = [];
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			const observed = observe(context);
			if (observed) turns.push(observed);
			return completedStream("Answered.");
		});
		await fs.writeFile(
			path.join(tempDir, "config.yml"),
			"modelRoles:\n  default: openai/gpt-4o-mini\nplan:\n  enabled: false\n",
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

	test("the refusal names the setting that turns it back on", async () => {
		const created = await client.request(1, { CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession emitted no ActiveSession");

		const refused = await client.request(2, { SetSessionMode: { session, mode: "plan" } });
		const failure = refused.outcome as Failure;
		expect(failure.RequestFailed?.error.code).toBe("MODE_DISABLED");
		// The same sentence the terminal's `/plan` prints, so the two clients
		// refuse the same thing the same way.
		expect(failure.RequestFailed?.error.message).toBe("Plan mode is disabled. Enable it in settings (plan.enabled).");

		// The refusal reached nothing: the next turn runs, unrestricted.
		expect(await planTurn(client, turns, session, 3)).toBe(false);
	});
});
