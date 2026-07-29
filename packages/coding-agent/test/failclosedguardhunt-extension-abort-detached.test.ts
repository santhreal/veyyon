/**
 * WHICH BUG THIS LOCKS OUT: the extension context's `abort()` handed a promise
 * into a `() => void` slot, so a failing abort killed the whole session.
 *
 * `ExtensionContextActions.abort` is declared `() => void`. The wiring in
 * `ExtensionUiController` was written as the expression-bodied arrow
 * `abort: () => this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL })`.
 * TypeScript ACCEPTS that: a value-returning function is assignable to a
 * void-returning signature. The promise is therefore created, returned into a
 * slot nobody reads, and dropped, with no rejection handler ever attached
 * (`ExtensionRunner` calls it as a bare `this.#abortFn()`).
 *
 * When that abort rejected, the rejection reached `@veyyon/utils` postmortem's
 * global `unhandledRejection` hook, which prints a fatal crash report and calls
 * `process.exit(1)`. The user pressed Esc, or an extension called
 * `ctx.abort()`, and instead of a cancelled turn they lost the session, with a
 * stack pointing at the keystroke handler rather than at the teardown step that
 * actually failed.
 *
 * The repo already had the cure: `abortDetached(session, where, reason)`, whose
 * own doc comment opens with "`void session.abort(...)` is NOT this". It was
 * applied at some abort wirings and missed at others, including both
 * `ExtensionContextActions` blocks in this controller, and at the headless
 * `ExtensionCommandContext` that `AgentSession` publishes when no extension
 * runner is present. The two suites below pin the interactive wiring and the
 * headless one.
 *
 * WHAT BREAKS IF THIS REGRESSES: put the bare expression arrow back and a
 * rejecting abort terminates the session again. The tests below fail two ways
 * at once, both deliberate: the "Detached session abort failed" warning
 * disappears, and Bun reports the floated rejection as an unhandled error
 * against this file.
 *
 * Note the deliberate absence of a source-text assertion. These drive the real
 * `initializeHookRunner` wiring and invoke the real `abort` it publishes, so
 * they pass for ANY implementation that contains the rejection, not only for
 * the one that happens to call `abortDetached`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { LoadedCustomCommand } from "@veyyon/coding-agent/extensibility/custom-commands";
import type { ExtensionContextActions, ExtensionUIContext } from "@veyyon/coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { logger } from "@veyyon/utils";

/** One captured `logger.warn` call. */
interface WarnEntry {
	message: string;
	fields?: Record<string, unknown>;
}

/** How a fake session's `abort` should behave for a given test. */
type AbortBehaviour = () => Promise<unknown> | undefined;

let warnEntries: WarnEntry[];
let warnSpy: ReturnType<typeof vi.spyOn>;

/**
 * Build the controller against a fake context and return the `abort` it
 * published to the runner. Only the members `initializeHookRunner` actually
 * reaches are provided: it reads `session.extensionRunner`, builds three
 * literals whose members are all lazy arrows, and hands them to
 * `initialize`. Capturing there is what makes this a test of the WIRING rather
 * than of `abortDetached` in isolation.
 */
function publishedAbort(behaviour: AbortBehaviour): {
	abort: () => void;
	abortCalls: Array<{ reason?: string } | undefined>;
} {
	const abortCalls: Array<{ reason?: string } | undefined> = [];
	let captured: ExtensionContextActions | undefined;
	const ctx = {
		session: {
			extensionRunner: {
				initialize: (_actions: unknown, contextActions: ExtensionContextActions) => {
					captured = contextActions;
				},
			},
			abort: (options?: { reason?: string }) => {
				abortCalls.push(options);
				return behaviour();
			},
		},
		// Unchecked by necessity and safe by inspection: `initializeHookRunner`
		// touches only `session.extensionRunner`, and the members it builds are
		// lazy arrows, so the 200-odd other context members are never read. A
		// real `InteractiveModeContext` would drag in a live TUI.
	} as unknown as InteractiveModeContext;

	// Passed straight through to `initialize` without being read.
	const uiContext = {} as ExtensionUIContext;
	const controller = new ExtensionUiController(ctx);
	controller.initializeHookRunner(uiContext, true);
	if (!captured) throw new Error("initializeHookRunner did not publish context actions");
	return { abort: captured.abort, abortCalls };
}

/** Yield the event loop so a floated rejection becomes observable, with no wall-clock delay. */
async function drainEventLoop(turns = 4): Promise<void> {
	for (let i = 0; i < turns; i++) {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

describe("extension context abort is detached, not floated", () => {
	beforeEach(() => {
		warnEntries = [];
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(((message: string, fields?: Record<string, unknown>) => {
			warnEntries.push({ message, fields });
		}) as unknown as typeof logger.warn);
	});

	afterEach(() => {
		warnSpy.mockRestore();
		vi.restoreAllMocks();
	});

	it("contains a rejecting abort instead of letting it reach the process", async () => {
		const { abort } = publishedAbort(() => Promise.reject(new Error("teardown step failed")));

		expect(() => abort()).not.toThrow();
		await drainEventLoop();

		const contained = warnEntries.filter(entry => entry.message.includes("Detached session abort failed"));
		expect(contained).toHaveLength(1);
		// The log has to name the failing step, which is the whole reason the
		// crash this replaced was undiagnosable.
		expect(String(Bun.inspect(contained[0].fields))).toContain("teardown step failed");
	});

	it("passes the user-interrupt reason so the transcript can tell a deliberate abort apart", async () => {
		const { abort, abortCalls } = publishedAbort(() => Promise.resolve());

		abort();
		await drainEventLoop();

		// `reason` rides the AbortController and surfaces on the aborted message.
		// Containment must not cost the caller that distinction.
		expect(abortCalls).toEqual([{ reason: USER_INTERRUPT_LABEL }]);
	});

	it("stays quiet when the abort succeeds", async () => {
		const { abort } = publishedAbort(() => Promise.resolve());

		abort();
		await drainEventLoop();

		expect(warnEntries.filter(entry => entry.message.includes("Detached session abort failed"))).toHaveLength(0);
	});

	it("contains an abort that throws synchronously before returning a promise", async () => {
		// Adversarial: a guard clause inside `abort()` can throw on the caller's
		// stack, which a promise-only rejection handler would miss entirely.
		const { abort } = publishedAbort(() => {
			throw new Error("threw before awaiting");
		});

		expect(() => abort()).not.toThrow();
		await drainEventLoop();

		expect(warnEntries.filter(entry => entry.message.includes("Detached session abort failed"))).toHaveLength(1);
	});

	it("contains an abort that rejects with a bare string rather than an Error", async () => {
		// Adversarial: a rejection handler receives `unknown`. Code assuming
		// `err.message` throws a second time, and on this path that second throw
		// is itself unhandled.
		const { abort } = publishedAbort(() => Promise.reject("not an Error"));

		expect(() => abort()).not.toThrow();
		await drainEventLoop();

		expect(warnEntries.filter(entry => entry.message.includes("Detached session abort failed"))).toHaveLength(1);
	});

	it("contains an abort that returns undefined instead of a promise", async () => {
		// Boundary: `DetachedAbortTarget.abort` is typed `Promise<unknown> | undefined`,
		// so the containment must not assume a promise came back.
		const { abort } = publishedAbort(() => undefined);

		expect(() => abort()).not.toThrow();
		await drainEventLoop();

		expect(warnEntries.filter(entry => entry.message.includes("Detached session abort failed"))).toHaveLength(0);
	});

	it("contains every rejection when abort is invoked repeatedly", async () => {
		// A user leaning on Esc produces several aborts in a row; one contained
		// rejection must not mask the rest.
		const { abort } = publishedAbort(() => Promise.reject(new Error("still failing")));

		abort();
		abort();
		abort();
		await drainEventLoop();

		expect(warnEntries.filter(entry => entry.message.includes("Detached session abort failed"))).toHaveLength(3);
	});
});

describe("headless command-context abort is detached, not floated", () => {
	let session: AgentSession | undefined;

	beforeEach(() => {
		warnEntries = [];
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(((message: string, fields?: Record<string, unknown>) => {
			warnEntries.push({ message, fields });
		}) as unknown as typeof logger.warn);
	});

	afterEach(async () => {
		warnSpy.mockRestore();
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	/**
	 * Reach the no-UI `#createCommandContext` fallback. A session built without
	 * an extension runner publishes its own `ExtensionCommandContext`, and a
	 * custom command is the supported way in: `prompt("/boom")` runs the handler
	 * and returns without contacting a model. `HookContext.abort()` is declared
	 * `abort(): void` and documented "fire-and-forget, does not wait", which is
	 * precisely why the promise underneath it needs a handler.
	 */
	async function runAbortCommand(behaviour: () => Promise<void>): Promise<void> {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("expected bundled gpt-4o-mini");
		// The custom-command path never reads the registry, and a real one needs
		// auth storage on disk.
		const modelRegistry = {} as ModelRegistry;
		const customCommands: LoadedCustomCommand[] = [
			{
				path: "abort-command.ts",
				resolvedPath: "/test/abort-command.ts",
				source: "project",
				command: {
					name: "boom",
					description: "invokes ctx.abort()",
					execute(_args, ctx) {
						ctx.abort();
					},
				},
			},
		];
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry,
			customCommands,
		});
		vi.spyOn(session, "abort").mockImplementation(behaviour);
		await session.prompt("/boom");
	}

	it("contains a rejecting abort raised from a custom command", async () => {
		await runAbortCommand(() => Promise.reject(new Error("headless teardown failed")));
		await drainEventLoop();

		const contained = warnEntries.filter(entry => entry.message.includes("Detached session abort failed"));
		expect(contained).toHaveLength(1);
		expect(String(Bun.inspect(contained[0].fields))).toContain("headless teardown failed");
	});

	it("stays quiet when the headless abort succeeds", async () => {
		await runAbortCommand(() => Promise.resolve());
		await drainEventLoop();

		expect(warnEntries.filter(entry => entry.message.includes("Detached session abort failed"))).toHaveLength(0);
	});
});
