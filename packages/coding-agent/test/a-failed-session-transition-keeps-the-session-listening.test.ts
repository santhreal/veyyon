/**
 * AgentSession detaches its agent-event handler while it swaps transcripts (`switchSession`,
 * `reload`, `newSession`, `/drop`) or compacts. That handler is the only path that writes a turn to
 * the session file and forwards its events to listeners, so a transition that failed after
 * detaching and before reattaching left the session deaf: every later turn ran against the model,
 * reached no listener and was never persisted. `switchSession` detached before flushing the
 * outgoing transcript, and `newSession` detached across every awaited step with the reattach as the
 * last line of the success path.
 *
 * Class closed: a throw from ANY session-manager call a transition makes, including a second throw
 * inside the `switchSession` rollback, leaves the session delivering and persisting the next turn.
 * The sweep records the calls each transition makes on an unfaulted run and injects a throw at each
 * position in turn, so a step added to a transition joins the sweep without editing this file.
 *
 * Gap: throws from collaborators other than the session manager (extension runner, MCP restore,
 * agent registry) are not injected. They run inside the same scoped reattach, which the
 * session-manager faults exercise at every position of each transition. The two-message fixture is
 * too small to compact, so the `compact` sweep covers its refusal path and not a summary that lands.
 * A new transition that detaches agent events is not swept until it is added to `TRANSITIONS`; the
 * only detach outside `#whileDisconnectedFromAgent` is dispose.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

const PROBE_REPLY = "reply after the transition";

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	targetFile: string;
	faults: FaultInjector;
}

/**
 * Wraps every `SessionManager.prototype` method on one instance. While armed it records each call
 * in order and throws at the positions listed in `failAt`.
 */
class FaultInjector {
	readonly calls: string[] = [];
	#armed = false;
	#failAt: ReadonlySet<number> = new Set();
	readonly #restore: (() => void)[] = [];

	constructor(sessionManager: SessionManager) {
		const target = sessionManager as unknown as Record<string, unknown>;
		for (const name of Object.getOwnPropertyNames(SessionManager.prototype)) {
			if (name === "constructor") continue;
			const original = Object.getOwnPropertyDescriptor(SessionManager.prototype, name)?.value;
			if (typeof original !== "function") continue;
			target[name] = (...args: unknown[]) => {
				if (this.#armed) {
					const position = this.calls.length;
					this.calls.push(name);
					if (this.#failAt.has(position)) throw new Error(`injected fault at call ${position} (${name})`);
				}
				return original.apply(sessionManager, args);
			};
			this.#restore.push(() => delete target[name]);
		}
	}

	arm(failAt: readonly number[]): void {
		this.calls.length = 0;
		this.#failAt = new Set(failAt);
		this.#armed = true;
	}

	disarm(): void {
		this.#armed = false;
	}

	restore(): void {
		this.disarm();
		for (const restore of this.#restore.splice(0)) restore();
	}
}

interface Transition {
	name: string;
	run(harness: Harness): Promise<unknown>;
	/** Also inject a second throw at every call the first throw's recovery makes. */
	sweepRecovery: boolean;
}

const TRANSITIONS: readonly Transition[] = [
	{
		name: "switchSession to another transcript",
		run: h => h.session.switchSession(h.targetFile),
		sweepRecovery: true,
	},
	{ name: "reload of the current transcript", run: h => h.session.reload(), sweepRecovery: true },
	{ name: "newSession", run: h => h.session.newSession(), sweepRecovery: false },
	{ name: "newSession with drop", run: h => h.session.newSession({ drop: true }), sweepRecovery: false },
	{ name: "compact", run: h => h.session.compact(), sweepRecovery: false },
];

describe("a failed session transition keeps the session listening", () => {
	let tempDir: string;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `veyyon-transition-fault-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	async function createHarness(): Promise<Harness> {
		const mock = createMockModel({ handler: { content: [PROBE_REPLY], stopReason: "stop" } });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test system prompt"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();

		const target = SessionManager.create(tempDir, tempDir);
		target.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await target.flush();
		const targetFile = target.getSessionFile();
		await target.close();
		if (!targetFile) throw new Error("expected a persisted target session file");

		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		authStorage.setRuntimeApiKey("mock", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, `models-${Snowflake.next()}.yml`)),
		});
		const faults = new FaultInjector(sessionManager);
		cleanups.push(
			() => authStorage.close(),
			() => session.dispose(),
			() => faults.restore(),
		);
		return { session, sessionManager, targetFile, faults };
	}

	/** Runs the transition with throws at `failAt` and returns the calls it made. */
	async function runFaulted(harness: Harness, transition: Transition, failAt: readonly number[]): Promise<string[]> {
		harness.faults.arm(failAt);
		try {
			await transition.run(harness);
		} catch {
			// The transition may fail; what it leaves behind is the contract under test.
		} finally {
			harness.faults.disarm();
		}
		return harness.faults.calls.slice();
	}

	/** Null when the next turn reached a listener and the session file; otherwise what was missing. */
	async function probeNextTurn(harness: Harness): Promise<string | null> {
		const roles: string[] = [];
		const unsubscribe = harness.session.subscribe(event => {
			if (event.type === "message_end") roles.push(event.message.role);
		});
		try {
			await harness.session.prompt("turn after the transition");
			await harness.session.waitForIdle();
		} catch (error) {
			return `the next turn threw: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			unsubscribe();
		}
		if (!roles.includes("assistant")) return `listener saw message_end roles ${JSON.stringify(roles)}`;
		const last = harness.session.sessionManager.getBranch().at(-1);
		const persisted =
			last?.type === "message" &&
			last.message.role === "assistant" &&
			JSON.stringify(last.message.content).includes(PROBE_REPLY);
		return persisted ? null : `session file ends with ${last?.type ?? "nothing"}, not the assistant reply`;
	}

	for (const transition of TRANSITIONS) {
		it(`${transition.name}: every injected session-manager fault leaves the next turn delivered and persisted`, async () => {
			const baseline = await createHarness();
			const calls = await runFaulted(baseline, transition, []);
			expect(calls.length).toBeGreaterThan(0);
			expect(await probeNextTurn(baseline)).toBeNull();

			const failures: string[] = [];
			let cases = 0;
			for (let first = 0; first < calls.length; first++) {
				const plans: number[][] = [[first]];
				if (transition.sweepRecovery) {
					const recovery = await runFaulted(await createHarness(), transition, [first]);
					for (let second = first + 1; second < recovery.length; second++) plans.push([first, second]);
				}
				for (const failAt of plans) {
					cases++;
					const harness = await createHarness();
					const faulted = await runFaulted(harness, transition, failAt);
					const problem = await probeNextTurn(harness);
					if (problem !== null) {
						failures.push(
							`${failAt.map(position => `${position}:${faulted[position]}`).join(" + ")} -> ${problem}`,
						);
					}
				}
			}
			expect(cases).toBeGreaterThanOrEqual(calls.length);
			expect(failures).toEqual([]);
		}, 120_000);
	}
});
