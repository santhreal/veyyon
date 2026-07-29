/**
 * WHICH BUG THIS LOCKS OUT: a command-metadata listener that REJECTED used to
 * kill the session, while one that THREW was handled cleanly.
 *
 * `AgentSession#notifyCommandMetadataChanged` invoked every registered listener
 * as `void listener()` inside a `try`/`catch`. Two facts make that a live bug
 * rather than a style nit:
 *
 *  1. `CommandMetadataChangedListener` is declared `() => void | Promise<void>`,
 *     so the published contract INVITES an async listener.
 *  2. A `catch` block only ever observes a SYNCHRONOUS throw. `void` discards
 *     the returned promise, so an async listener that rejected walked straight
 *     past the handler sitting three lines below it.
 *
 * The escaped rejection is not merely unlogged. `@veyyon/utils` postmortem
 * installs a global `unhandledRejection` handler that prints a fatal crash
 * report and calls `process.exit(1)`. `setMCPPromptCommands` is called whenever
 * MCP server prompts are (re)loaded, including on reconnect, so a single async
 * subscriber failing during a routine prompt reload took the whole TUI down at
 * a moment the user did not act.
 *
 * WHAT BREAKS IF THIS REGRESSES: restore `void listener()` and an async
 * subscriber whose work rejects terminates the session instead of logging. The
 * tests below fail in two independent ways when that happens, both deliberate:
 * the containment entry disappears from the `logger.error` capture, and Bun
 * reports the floated rejection as an unhandled error against this file.
 *
 * THE CONTRACT: a listener that rejects degrades EXACTLY like a listener that
 * throws. Same sink, same message, session survives, siblings still run.
 * Silently swallowing the rejection would also stop the crash and would be the
 * wrong fix: the operator has to be able to find out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";

/** One captured `logger.error` call. */
interface ErrorEntry {
	message: string;
	fields?: Record<string, unknown>;
}

/** A live `logger.error` capture plus its restore hook. */
interface ErrorCapture {
	entries: ErrorEntry[];
	restore: () => void;
}

/**
 * Capture `logger.error` so containment is asserted rather than assumed. The
 * log line is the loud half of the degradation and is what an operator greps
 * for after a listener starts misbehaving.
 */
function captureErrors(): ErrorCapture {
	const entries: ErrorEntry[] = [];
	const spy = vi.spyOn(logger, "error").mockImplementation(((message: string, fields?: Record<string, unknown>) => {
		entries.push({ message, fields });
	}) as unknown as typeof logger.error);
	return { entries, restore: () => spy.mockRestore() };
}

/** Yield the event loop so a floated rejection becomes observable, with no wall-clock delay. */
async function drainEventLoop(turns = 4): Promise<void> {
	for (let i = 0; i < turns; i++) {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

/** Entries naming the command-metadata containment path. */
function metadataEntries(capture: ErrorCapture): ErrorEntry[] {
	return capture.entries.filter(entry => entry.message.includes("Command metadata listener"));
}

describe("command-metadata listener rejection containment", () => {
	let session: AgentSession;
	let authStorage: AuthStorage;
	let tempDir: TempDir;
	let errors: ErrorCapture;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-fcgh-listener-rejections-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		errors = captureErrors();
	});

	afterEach(async () => {
		errors.restore();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
	});

	it("runs a well-behaved async listener to completion without logging an error", async () => {
		let ran = false;
		session.subscribeCommandMetadataChanged(async () => {
			await Promise.resolve();
			ran = true;
		});

		session.setMCPPromptCommands([]);
		await drainEventLoop();

		expect(ran).toBe(true);
		expect(metadataEntries(errors)).toHaveLength(0);
	});

	it("contains a listener that returns a rejected promise instead of letting it reach the process", async () => {
		session.subscribeCommandMetadataChanged(() => Promise.reject(new Error("metadata subscriber exploded")));

		// The notify call itself must stay synchronous and must not throw: its
		// caller is `setMCPPromptCommands`, ordinary bookkeeping with no catch.
		expect(() => session.setMCPPromptCommands([])).not.toThrow();
		await drainEventLoop();

		const entries = metadataEntries(errors);
		expect(entries).toHaveLength(1);
		expect(String(Bun.inspect(entries[0].fields))).toContain("metadata subscriber exploded");
	});

	it("logs a rejecting listener through the same sink and message as a throwing one", async () => {
		session.subscribeCommandMetadataChanged(() => {
			throw new Error("sync arm");
		});
		session.subscribeCommandMetadataChanged(() => Promise.reject(new Error("async arm")));

		session.setMCPPromptCommands([]);
		await drainEventLoop();

		const entries = metadataEntries(errors);
		expect(entries).toHaveLength(2);
		// Indistinguishable to an operator: identical message, one sink. If the
		// async arm ever grows its own wording the two failure modes stop being
		// greppable as one thing.
		expect(entries[0].message).toBe(entries[1].message);
	});

	it("still notifies later listeners after an earlier one rejects", async () => {
		const order: string[] = [];
		session.subscribeCommandMetadataChanged(() => {
			order.push("first");
			return Promise.reject(new Error("first blew up"));
		});
		session.subscribeCommandMetadataChanged(() => {
			order.push("second");
		});

		session.setMCPPromptCommands([]);
		await drainEventLoop();

		// A broken subscriber must not silence the rest of the fan-out; command
		// metadata is how the UI learns the command list changed.
		expect(order).toEqual(["first", "second"]);
		expect(metadataEntries(errors)).toHaveLength(1);
	});

	it("contains a listener that rejects with a bare string rather than an Error", async () => {
		// Adversarial: `catch (err)` and a rejection handler both receive
		// `unknown`. Code that assumes `err.message` throws a SECOND time, and
		// on the rejection path that second throw is itself unhandled.
		session.subscribeCommandMetadataChanged(() => Promise.reject("a bare string, not an Error"));

		expect(() => session.setMCPPromptCommands([])).not.toThrow();
		await drainEventLoop();

		expect(metadataEntries(errors)).toHaveLength(1);
	});

	it("contains a listener that rejects only after an await boundary", async () => {
		// The rejection lands on a later microtask turn, long after
		// `#notifyCommandMetadataChanged` has returned. Nothing on the stack can
		// catch it by then; only a handler attached to the promise can.
		session.subscribeCommandMetadataChanged(async () => {
			await new Promise<void>(resolve => setTimeout(resolve, 1));
			throw new Error("late rejection");
		});

		session.setMCPPromptCommands([]);
		await drainEventLoop(8);

		expect(metadataEntries(errors)).toHaveLength(1);
	});

	it("does not invoke a rejecting listener again once it has unsubscribed", async () => {
		let calls = 0;
		const unsubscribe = session.subscribeCommandMetadataChanged(() => {
			calls++;
			return Promise.reject(new Error("still registered"));
		});

		session.setMCPPromptCommands([]);
		await drainEventLoop();
		unsubscribe();
		session.setMCPPromptCommands([]);
		await drainEventLoop();

		// Containment must not accidentally re-register or retain the listener.
		expect(calls).toBe(1);
		expect(metadataEntries(errors)).toHaveLength(1);
	});
});
