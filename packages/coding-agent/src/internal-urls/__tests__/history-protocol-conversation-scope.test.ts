/**
 * `history://` when the process drives TWO conversations.
 *
 * WHY TWO, AND WHY REFUSAL RATHER THAN A FILTER. The disk fallback already
 * refuses an id whose transcript exists in two artifacts dirs. The REGISTRY path
 * never reached it: `registry.get(id)` is a process-global lookup keyed by a
 * name the caller chose, so a live ref belonging to another conversation was
 * served straight out, and the bare index listed every conversation's agents in
 * one table.
 *
 * There is nothing to filter with. `ProtocolHandler.resolve` is handed a URL and
 * a `ResolveContext` carrying cwd, settings and skills, and no agent id and no
 * scope, so the handler genuinely cannot tell who is asking. A transcript is the
 * fullest record an agent leaves, so it refuses while the answer is unknowable
 * and says why, which is the shape the `local://` root lookup already uses.
 *
 * With one conversation the refusal never triggers, and the leak it closes does
 * not exist to be observed: a one-conversation test proves nothing either way.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { HistoryProtocolHandler } from "../history-protocol";
import { resetRegisteredArtifactDirsForTests } from "../registry-helpers";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

/** A live root session with no artifacts dir, so nothing is read off disk. */
function liveRoot(id: string, scope: string): void {
	AgentRegistry.global().register({
		id,
		displayName: "main",
		kind: "main",
		session: { sessionManager: { getArtifactsDir: () => null } } as unknown as AgentSession,
		sessionFile: null,
		scope,
	});
}

describe("history:// across conversations", () => {
	/** The leak: naming another conversation's agent handed over its whole transcript. */
	it("refuses a lookup while more than one conversation is live", async () => {
		liveRoot("acp:a", "session-a");
		liveRoot("acp:b", "session-b");
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			parentId: "acp:b",
			session: { messages: ["secret"] } as unknown as AgentSession,
			status: "running",
		});

		const resolve = new HistoryProtocolHandler().resolve(new URL("history://Scout") as never);

		await expect(resolve).rejects.toThrow(/2 conversations at once/);
	});

	/** The index is the same leak in table form: every conversation's agents in one list. */
	it("refuses the bare index while more than one conversation is live", async () => {
		liveRoot("acp:a", "session-a");
		liveRoot("acp:b", "session-b");

		const resolve = new HistoryProtocolHandler().resolve(new URL("history://") as never);

		await expect(resolve).rejects.toThrow(/2 conversations at once/);
	});

	/**
	 * Completions go quiet rather than throwing: a completer must not raise, and
	 * offering names whose read is refused would put another conversation's agent
	 * ids in the operator's autocomplete, which is the leak stated plainly.
	 */
	it("offers no completions while more than one conversation is live", async () => {
		liveRoot("acp:a", "session-a");
		liveRoot("acp:b", "session-b");

		expect(await new HistoryProtocolHandler().complete()).toEqual([]);
	});

	/**
	 * The other direction, and the reason the trigger is "more than one live
	 * root" rather than "more than one ref": every ordinary single-conversation
	 * run, which is every interactive session, still resolves. Without this a
	 * refusal that broke `history://` outright would look like a fix.
	 */
	it("resolves normally when the process drives one conversation", async () => {
		liveRoot("acp:a", "session-a");
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			parentId: "acp:a",
			session: { messages: [] } as unknown as AgentSession,
			status: "running",
		});

		const resource = await new HistoryProtocolHandler().resolve(new URL("history://Scout") as never);

		expect(resource.notes).toContain("Source: live session");
	});
});
