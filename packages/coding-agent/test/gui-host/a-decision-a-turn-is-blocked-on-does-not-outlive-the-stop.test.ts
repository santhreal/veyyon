/**
 * WHY: a turn blocked on an operator decision could not be stopped at all.
 *
 * The defect: `RegisteredToolAdapter.execute` raised its approval card with a
 * shared options object that carried no `AbortSignal`, so nothing took the card
 * down. `AgentSession.abort` aborts the tool signal and then awaits
 * `waitForIdle()`, which waits on the prompt, which waits on the card -- so the
 * stop control sent no reply at all, and neither did the actions that end a
 * running turn before leaving the session. Measured on the desktop: with a
 * `read` approval up, `AbortTurn` and `OpenSession` both went unanswered for
 * the whole probe window; after the fix both answer in under a second.
 *
 * The class it closes: a decision a turn is blocked on outliving the stop. Two
 * halves, because the two kinds of decision are reached by different things.
 * A decision raised WITH a signal is reached by the abort itself and reports
 * its own outcome, so the suite drives the reachable one -- a tool approval --
 * through the real host, wire, agent and tool wrapper, and asserts the stop
 * answers, the card is withdrawn, and the model is not told the operator
 * refused a call the operator was never asked about. A decision raised WITHOUT
 * one -- a plan review, whose standing resolve handler is given no signal to
 * pass on -- is reached by nothing, so `abortTurn` takes it down before it
 * awaits, and the second half sweeps every raiser the ledger exposes to pin
 * which of the two each one is.
 *
 * The sweep reads its members off `InteractionLedger.prototype` and off the
 * keys of `PendingDecisions` at run time, both by exact equality, so a new
 * decision kind or a new raiser arrives as a red test rather than as a gap.
 *
 * What it does not catch: the window's own drawing of a withdrawn card, which
 * `crates/veyyon-desktop-surface` owns; plan mode driven end to end, since the
 * plan review is raised by a standing handler behind a plan file and a
 * `resolve` call, and the sweep covers the property that matters about it (no
 * signal reaches it, so the stop must); and an extension host that raises a
 * decision on something other than this ledger.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
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
import { InteractionLedger } from "../../src/gui-host/interactions";
import type { PendingDecisions } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** The prompt whose turn blocks on an approval. */
const PROMPT = "Read the working directory";
/** The tool the config below marks `prompt`, so calling it raises a card. */
const GATED_TOOL = "read";
/** The prompt whose turn blocks on a plan review. */
const PLAN_PROMPT = "Submit the plan for review";

/**
 * How long a stop may take to answer while a decision is up.
 *
 * A bound, not a settle delay: nothing here waits for it on the passing path.
 * The defect made these requests never answer, and a suite that can only
 * observe a wrong reply cannot see a reply that never comes -- so the deadline
 * is the assertion. Generous by an order of magnitude against the measured
 * sub-second answer, so a loaded machine does not read as a regression.
 */
const STOP_ANSWERS_WITHIN_MS = 10_000;

/** Ticks a bounded wait spends before giving up, in the ledger sweep. */
const SETTLE_TICKS = 50;

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

/** A reply that calls the gated tool, which blocks the turn on an approval. */
function gatedToolStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const call = { type: "toolCall", id: "call-gated-1", name: GATED_TOOL, arguments: { path: "." } } as const;
	const message = assistantMessage([call], "toolUse");
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
	});
	return stream;
}

/**
 * A reply that submits the plan for approval, which blocks the turn on a plan
 * review: the one decision no signal reaches, since `setStandingResolveHandler`
 * takes a handler of the input alone and has no signal to hand it.
 */
function planResolveStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const call = {
		type: "toolCall",
		id: "call-resolve-1",
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

/** A stream that finishes on its own, for every request that is not the turn under test. */
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
function isTheTurnUnderTest(context: Context): boolean {
	const first = context.messages[0]?.content;
	if (context.messages.length === 1 && typeof first === "string" && first.startsWith("<user>")) return false;
	return JSON.stringify(context.messages).includes(PROMPT);
}

/** The request that carries the plan-mode prompt, by the same rule. */
function isThePlanTurn(context: Context): boolean {
	const first = context.messages[0]?.content;
	if (context.messages.length === 1 && typeof first === "string" && first.startsWith("<user>")) return false;
	return JSON.stringify(context.messages).includes(PLAN_PROMPT);
}

/** A sentinel that wins the race when the request under test never answers. */
const TIMED_OUT = Symbol("the stop did not answer");

async function withinTheBound<T>(work: Promise<T>): Promise<T> {
	const answered = await Promise.race([work, sleep(STOP_ANSWERS_WITHIN_MS, TIMED_OUT)]);
	if (answered === TIMED_OUT) throw new Error("the stop did not answer while a decision was up");
	return answered as T;
}

/** Whether `promise` settles within a bounded number of event-loop turns. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	for (let tick = 0; tick < SETTLE_TICKS && !settled; tick++) {
		await new Promise<void>(resolve => {
			setImmediate(resolve);
		});
	}
	return settled;
}

describe("a decision a turn is blocked on does not outlive the stop", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;

	/** Rewrite the config and bring the host up on it, replacing any already running. */
	async function startHost(config: string): Promise<void> {
		if (server) {
			await server.close();
			server = null;
		}
		await fs.writeFile(path.join(tempDir, "config.yml"), config, "utf8");
		resetSettingsForTest();
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
	}

	beforeEach(async () => {
		// `Settings` is process-wide and reads its file once, so a host started on
		// one config would otherwise keep answering from the file the previous
		// test wrote -- which is how the plan-mode arm ran with plan mode off.
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-blocked-decision-"));
		sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			if (isThePlanTurn(context)) return planResolveStream();
			return isTheTurnUnderTest(context) ? gatedToolStream() : completedStream("Answered.");
		});
		await startHost(`modelRoles:\n  default: openai/gpt-4o-mini\ntools:\n  approval:\n    ${GATED_TOOL}: prompt\n`);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (server) {
			await server.close();
			server = null;
		}
		resetSettingsForTest();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** A client of its own, so one action's leftover frames cannot be read as the next one's. */
	async function connect(): Promise<TestSocketClient> {
		if (!server) throw new Error("the host is not running");
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		return client;
	}

	/** A session on disk the desktop can navigate to, with one message of its own. */
	async function sessionOnDisk(text: string): Promise<string> {
		const storage = new FileSessionStorage();
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		await sm.flush();
		await sm.ensureOnDisk();
		return sm.getSessionId();
	}

	/**
	 * Create a session, prompt it, and return once the client has been sent an
	 * approval card. The card is the state under test: read from the wire, so
	 * the turn is genuinely blocked and not merely slow.
	 */
	async function sessionBlockedOnAnApproval(client: TestSocketClient): Promise<string> {
		const created = await client.request(1, { CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession emitted no ActiveSession");
		client.send({ id: 2, action: { SubmitPrompt: { session, text: PROMPT } } });
		for (let read = 0; read < 400; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			const section = (frame.Snapshot as { Interactions?: InteractionsSection } | undefined)?.Interactions;
			if (section?.pending.approvals.length) {
				expect(section.session).toBe(session);
				expect(section.pending.approvals[0]?.tool_name).toBe(GATED_TOOL);
				return session;
			}
		}
		throw new Error("no approval card ever reached the client");
	}

	/** The messages `session` holds on disk, as `role/stopReason:content`. */
	async function messagesOnDisk(session: string): Promise<string[]> {
		for (const file of await fs.readdir(sessionDir)) {
			const sm = await SessionManager.open(path.join(sessionDir, file), undefined, undefined, {
				suppressBreadcrumb: true,
			});
			if (sm.getSessionId() !== session) continue;
			return sm
				.getEntries()
				.filter((entry: SessionEntry) => entry.type === "message")
				.map(entry => {
					const message = (entry as { message: { role: string; stopReason?: string; content: unknown } }).message;
					return `${message.role}/${message.stopReason ?? "-"}:${JSON.stringify(message.content)}`;
				});
		}
		throw new Error(`no file on disk holds session ${session}`);
	}

	/** The pending sets the client was sent, in order, for `session` only. */
	function pendingFor(frames: RequestFrame[], session: string): PendingDecisions[] {
		return snapshotSections<InteractionsSection>(frames, "Interactions")
			.filter(section => section.session === session)
			.map(section => section.pending);
	}

	test("the stop control answers while an approval is up, and withdraws it", async () => {
		const client = await connect();
		const session = await sessionBlockedOnAnApproval(client);

		const answer = await withinTheBound(client.request(3, { AbortTurn: { session } }));
		expect(answer.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		const withdrawn = pendingFor(answer.frames, session).at(-1);
		expect(withdrawn).toEqual({ approvals: [], questions: [], plans: [] });
	});

	test("a stopped call is not reported to the model as one the operator refused", async () => {
		const client = await connect();
		const session = await sessionBlockedOnAnApproval(client);
		await withinTheBound(client.request(3, { AbortTurn: { session } }));

		// The wrapper answers an unanswered card by its cause: a stop is a
		// cancellation, which the agent loop propagates, so the turn ends and
		// nothing claims a decision was made. Reading `undefined` as a refusal
		// instead put "denied by user" into the history as a tool error, which
		// the model then reasons around -- and, being a result rather than a
		// cancellation, invited the loop to re-issue the call the operator had
		// just stopped.
		const messages = (await messagesOnDisk(session)).join("\n");
		expect(messages).not.toContain("denied by user");
		expect(messages).not.toContain("denied for this session");
	});

	test("leaving the session answers while an approval is up, and withdraws it first", async () => {
		const client = await connect();
		const elsewhere = await sessionOnDisk("a session that was not blocked");
		const session = await sessionBlockedOnAnApproval(client);

		const answer = await withinTheBound(client.request(3, { OpenSession: { session: elsewhere } }));
		expect(answer.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		// Attribution, not merely emptiness: the ledger stamps every frame with
		// the session the client holds NOW, so a card withdrawn after the switch
		// would be published against the session the operator moved to.
		expect(pendingFor(answer.frames, session).at(-1)).toEqual({ approvals: [], questions: [], plans: [] });
		expect(pendingFor(answer.frames, elsewhere).at(-1)?.approvals ?? []).toEqual([]);
	});

	test("creating a session answers while an approval is up", async () => {
		const client = await connect();
		const session = await sessionBlockedOnAnApproval(client);

		const answer = await withinTheBound(client.request(3, { CreateSession: {} }));
		expect(answer.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		expect(pendingFor(answer.frames, session).at(-1)).toEqual({ approvals: [], questions: [], plans: [] });
	});

	test("branching answers while an approval is up", async () => {
		const client = await connect();
		const session = await sessionBlockedOnAnApproval(client);

		const answer = await withinTheBound(client.request(3, { BranchSession: { session } }));
		expect(answer.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		expect(pendingFor(answer.frames, session).at(-1)).toEqual({ approvals: [], questions: [], plans: [] });
	});

	/**
	 * The directory `local://` resolves to for a session: a `local` directory
	 * inside the session's artifacts directory, which is its file without the
	 * `.jsonl` suffix. Polled, since the host writes the file while it enters
	 * plan mode rather than when the session is created.
	 */
	async function localRootOf(session: string): Promise<string> {
		for (let read = 0; read < 200; read++) {
			for (const file of await fs.readdir(sessionDir)) {
				if (!file.endsWith(".jsonl")) continue;
				const sm = await SessionManager.open(path.join(sessionDir, file), undefined, undefined, {
					suppressBreadcrumb: true,
				});
				if (sm.getSessionId() !== session) continue;
				const dir = sm.getArtifactsDir();
				if (dir) return path.join(dir, "local");
			}
			await sleep(25);
		}
		throw new Error(`session ${session} never reached disk`);
	}

	test("the stop answers while a plan review is up, and no signal reaches that one", async () => {
		// Plan mode is the reachable decision that carries no signal at all: the
		// standing resolve handler is given the tool's input and nothing else, so
		// aborting the turn cannot reach the card the way it reaches an approval.
		// This is the member `abortTurn` has to take down itself, and the only
		// one whose stop hangs when it does not.
		await startHost("modelRoles:\n  default: openai/gpt-4o-mini\nplan:\n  enabled: true\n  defaultOnStartup: true\n");
		const client = await connect();
		const created = await client.request(1, { CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession emitted no ActiveSession");
		const localRoot = await localRootOf(session);
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "PLAN.md"), "# A plan\n\nDo the work.\n", "utf8");

		client.send({ id: 2, action: { SubmitPrompt: { session, text: PLAN_PROMPT } } });
		let raised = false;
		for (let read = 0; read < 400 && !raised; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			const section = (frame.Snapshot as { Interactions?: InteractionsSection } | undefined)?.Interactions;
			if (section?.pending.plans.length) {
				expect(section.session).toBe(session);
				raised = true;
			}
		}
		expect(raised).toBe(true);

		const answer = await withinTheBound(client.request(3, { AbortTurn: { session } }));
		expect(answer.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		expect(pendingFor(answer.frames, session).at(-1)).toEqual({ approvals: [], questions: [], plans: [] });
	});

	describe("every raiser the ledger exposes", () => {
		/**
		 * One invocation per raiser, with and without a signal. Pinned against
		 * the prototype by exact equality below, so a raiser added to the ledger
		 * turns this red instead of going unswept.
		 */
		const RAISERS: Record<string, (ledger: InteractionLedger, signal?: AbortSignal) => Promise<unknown>> = {
			approval: (ledger, signal) =>
				ledger.approval(`**Tool:** ${GATED_TOOL}\n**Scope:** This call only`, signal ? { signal } : undefined),
			choice: (ledger, signal) => ledger.choice("pick one", ["a", "b"], signal ? { signal } : undefined),
			text: (ledger, signal) => ledger.text("say something", signal ? { signal } : undefined),
			plan: (ledger, signal) => ledger.plan("# a plan", signal ? { signal } : undefined),
		};

		/** Prototype members that answer or report decisions rather than raising one. */
		const NOT_RAISERS = ["answer", "cancelAll", "cancelUnsignalled", "constructor", "isEmpty", "pending"];

		let listener: net.Server;
		let sockets: net.Socket[];

		beforeEach(async () => {
			sockets = [];
			listener = net.createServer(socket => sockets.push(socket));
			await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
		});

		afterEach(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => listener.close(() => resolve()));
		});

		/** A ledger writing to a real socket, so publishing a frame is real work. */
		async function ledgerOn(session: string): Promise<InteractionLedger> {
			const address = listener.address();
			if (address === null || typeof address === "string") throw new Error("the listener has no port");
			const socket = net.connect(address.port, "127.0.0.1");
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			sockets.push(socket);
			return new InteractionLedger(socket, () => session);
		}

		test("is swept here", () => {
			const raisers = Object.getOwnPropertyNames(InteractionLedger.prototype)
				.filter(name => !NOT_RAISERS.includes(name))
				.sort();
			expect(raisers).toEqual(Object.keys(RAISERS).sort());
		});

		test("carries every kind the wire can publish", async () => {
			const ledger = await ledgerOn("session-kinds");
			expect(Object.keys(ledger.pending()).sort()).toEqual(["approvals", "plans", "questions"]);
		});

		for (const [name, raise] of Object.entries(RAISERS)) {
			test(`${name} raised without a signal is taken down by the stop`, async () => {
				const ledger = await ledgerOn(`session-${name}-unsignalled`);
				const decision = raise(ledger);
				expect(ledger.isEmpty).toBe(false);

				ledger.cancelUnsignalled();
				expect(await settlesSoon(decision)).toBe(true);
				expect(ledger.isEmpty).toBe(true);
				expect(ledger.pending()).toEqual({ approvals: [], questions: [], plans: [] });
			});

			test(`${name} raised with a signal is left to the abort`, async () => {
				const ledger = await ledgerOn(`session-${name}-signalled`);
				const controller = new AbortController();
				const decision = raise(ledger, controller.signal);
				expect(ledger.isEmpty).toBe(false);

				// Left standing deliberately: resolving it here, before the signal
				// fires, is what made a stopped call indistinguishable from a
				// refused one at the caller.
				ledger.cancelUnsignalled();
				expect(await settlesSoon(decision)).toBe(false);
				expect(ledger.isEmpty).toBe(false);

				controller.abort();
				expect(await settlesSoon(decision)).toBe(true);
				expect(ledger.isEmpty).toBe(true);
			});
		}
	});
});
