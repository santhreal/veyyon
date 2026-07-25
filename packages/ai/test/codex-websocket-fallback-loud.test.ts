import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { CodexWebSocketSessionState } from "@veyyon/ai/providers/openai-codex-responses";
import { recordCodexWebSocketFailure } from "@veyyon/ai/providers/openai-codex-responses";
import { logger } from "@veyyon/utils";

/**
 * Losing the codex websocket transport is a degrade, and degrades are announced.
 *
 * The codex provider prefers a websocket transport and falls back to SSE when
 * it cannot keep one. The fallback is permanent for the session: once
 * `disableWebsocket` is set, every remaining turn goes over SSE. It is reached
 * five different ways (a fatal socket error, an exhausted retry budget, an
 * account connection limit hit with or without partial output already emitted,
 * a stream error, a failed reopen) and every one of them recorded it through
 * `CODEX_DEBUG && logger.debug(...)`.
 *
 * That guard is what makes this the worst silent fallback in the package rather
 * than an ordinary one: with `CODEX_DEBUG` unset, which is every default
 * install, the transport changed underneath the user and NOTHING was written
 * anywhere, at any level. A user watching their turns get slower had no line to
 * find even if they went looking. Law 10 bans this outright, and the SPEED
 * BOUND clause is the reason: a recall-preserving fallback that costs real
 * latency is still a production bug when it is invisible.
 *
 * The report is attached to the flag flip rather than to the five call sites,
 * so it fires exactly once per session however the fallback was reached, and so
 * a sixth call site cannot be added without inheriting it.
 */
describe("The codex websocket-to-SSE fallback announces itself", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A session that still has the websocket transport available. */
	function freshState(): CodexWebSocketSessionState {
		return {
			disableWebsocket: false,
			canAppend: false,
			fallbackCount: 0,
			prewarmed: false,
			stats: {} as CodexWebSocketSessionState["stats"],
		};
	}

	const fallbackWarnings = () => warnings.filter(entry => entry.message.includes("websocket transport failed"));

	/**
	 * The core case. The message has to say what the user will actually notice,
	 * which is slower turns, not that an internal flag was set.
	 */
	test("warns, naming the consequence, when the fallback is activated", () => {
		const state = freshState();

		recordCodexWebSocketFailure(state, true, { cause: "fatal-websocket-error", error: "401 unauthorized" });

		expect(state.disableWebsocket).toBe(true);
		const reported = fallbackWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("runs over SSE");
		expect(reported[0]?.message).toContain("slower");
		expect(reported[0]?.fields.cause).toBe("fatal-websocket-error");
		expect(reported[0]?.fields.error).toBe("401 unauthorized");
	});

	/**
	 * A retry that does NOT give up on the transport is not a degrade and must
	 * stay quiet. Without this the fix would fire on every transient reconnect,
	 * which is the ordinary case on a flaky network and would make the warning
	 * worth ignoring by the second turn.
	 */
	test("says nothing for a failure that keeps the websocket transport", () => {
		const state = freshState();

		recordCodexWebSocketFailure(state, false, { cause: "transient" });

		expect(state.disableWebsocket).toBe(false);
		expect(fallbackWarnings()).toHaveLength(0);
	});

	/**
	 * The bound. Later failures in an already-degraded session change nothing, so
	 * repeating the warning would add noise without adding information.
	 */
	test("warns once, not on every subsequent failure in the same session", () => {
		const state = freshState();

		recordCodexWebSocketFailure(state, true, { cause: "fatal-websocket-error" });
		recordCodexWebSocketFailure(state, true, { cause: "reopen-failed" });
		recordCodexWebSocketFailure(state, true, { cause: "stream-retry-budget-exhausted" });

		expect(fallbackWarnings()).toHaveLength(1);
		// The counter still only records the one transition that mattered.
		expect(state.fallbackCount).toBe(1);
	});

	/**
	 * Two sessions are two independent degrades. Bounding on a module-level flag
	 * instead of on session state would mean the second session's fallback is
	 * never announced, which is the original bug scoped down rather than fixed.
	 */
	test("warns separately for each session that loses the transport", () => {
		recordCodexWebSocketFailure(freshState(), true, { cause: "fatal-websocket-error" });
		recordCodexWebSocketFailure(freshState(), true, { cause: "reopen-failed" });

		const reported = fallbackWarnings();
		expect(reported).toHaveLength(2);
		expect(reported.map(entry => entry.fields.cause)).toEqual(["fatal-websocket-error", "reopen-failed"]);
	});

	/**
	 * The cause is what tells an operator whether to look at their account limits
	 * or their network, so a call site that forgets to pass one must still
	 * produce a usable line rather than `undefined`.
	 */
	test("still reports a usable line when no cause was supplied", () => {
		recordCodexWebSocketFailure(freshState(), true);

		const reported = fallbackWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.fields.cause).toBe("unknown");
	});

	/**
	 * A session that was already degraded before this call is not a new
	 * transition. This is the guard that keeps a re-entrant path from warning a
	 * second time for the same degrade.
	 */
	test("says nothing when the session had already fallen back", () => {
		const state = { ...freshState(), disableWebsocket: true, fallbackCount: 1 };

		recordCodexWebSocketFailure(state, true, { cause: "reopen-failed" });

		expect(fallbackWarnings()).toHaveLength(0);
		expect(state.fallbackCount).toBe(1);
	});
});
