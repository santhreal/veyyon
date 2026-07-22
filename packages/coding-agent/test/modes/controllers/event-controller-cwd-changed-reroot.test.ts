/**
 * EventController cwd_changed re-root wiring.
 *
 * A session-scoped working-directory change — the `/cwd` command or the agent's
 * `set_cwd` tool — flows through `AgentSession.setCwd`, which updates the
 * SessionManager cwd and `getProjectDir()` and then emits a `cwd_changed`
 * event. The interactive-mode handler for that event MUST run the full re-root
 * (`applyCwdChange`): reload project settings, plugins, capabilities, slash
 * commands, the ssh tool, and the system-prompt project framing for the new
 * directory. `/move` already does this; `/cwd` and `set_cwd` regressed to a
 * status-line-only handler, so the filesystem cwd moved but the agent's config
 * and command surface stayed pinned to the ORIGINAL directory.
 *
 * These tests lock the handler to `applyCwdChange(event.cwd)` so the two paths
 * can never drift apart again. If the handler reverts to only invalidating the
 * status line, the first test goes red.
 */
import { describe, expect, it, vi } from "bun:test";
import { EventController } from "@veyyon/coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

function createFixture() {
	const applyCwdChange = vi.fn(async (_cwd: string) => {});
	const statusLineInvalidate = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		applyCwdChange,
		statusLine: { invalidate: statusLineInvalidate, markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		ui: { requestRender, requestComponentRender: vi.fn() },
		settings: { get: vi.fn(() => false) },
		session: { isStreaming: false },
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, applyCwdChange };
}

function cwdChanged(previous: string, cwd: string): Extract<AgentSessionEvent, { type: "cwd_changed" }> {
	return { type: "cwd_changed", previous, cwd };
}

describe("EventController cwd_changed re-root", () => {
	it("re-roots the interactive session to the NEW directory via applyCwdChange", async () => {
		const { controller, applyCwdChange } = createFixture();

		await controller.handleEvent(cwdChanged("/old/project", "/new/project"));

		expect(applyCwdChange).toHaveBeenCalledTimes(1);
		expect(applyCwdChange).toHaveBeenCalledWith("/new/project");
	});

	it("passes the destination cwd, never the stale previous directory", async () => {
		const { controller, applyCwdChange } = createFixture();

		await controller.handleEvent(cwdChanged("/home/a/repo-one", "/home/a/repo-two"));

		const arg = applyCwdChange.mock.calls[0]?.[0];
		expect(arg).toBe("/home/a/repo-two");
		expect(arg).not.toBe("/home/a/repo-one");
	});

	it("awaits the re-root so project-settings/plugin reload completes before the handler resolves", async () => {
		const { controller } = createFixtureWithSlowReroot();
		const order: string[] = [];
		const rerootDone = () => order.push("reroot-done");
		slowRerootHook = rerootDone;

		await controller.handleEvent(cwdChanged("/x", "/y"));
		order.push("handler-returned");

		// The handler must AWAIT applyCwdChange; if it fired-and-forgot, the
		// reload would land after the turn continued and the new dir's config
		// would not be in effect for the next model call.
		expect(order).toEqual(["reroot-done", "handler-returned"]);
	});
});

let slowRerootHook: (() => void) | undefined;

function createFixtureWithSlowReroot() {
	const applyCwdChange = vi.fn(async (_cwd: string) => {
		await Promise.resolve();
		slowRerootHook?.();
	});
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		applyCwdChange,
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		settings: { get: vi.fn(() => false) },
		session: { isStreaming: false },
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), applyCwdChange };
}
