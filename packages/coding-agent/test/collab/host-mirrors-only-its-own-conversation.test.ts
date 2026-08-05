/**
 * What a collab guest is shown, and may act on, when the HOST process is also
 * driving a SECOND conversation.
 *
 * WHY TWO. The host mirrored `AgentRegistry.global().list()` — the whole process
 * — into the `welcome` frame's `agents`, and the snapshot is not display-only:
 * `agent-cmd` accepts chat, kill and revive for any id the guest was shown, and
 * `fetch-transcript` streams the raw session file for any id it names. So an
 * unfiltered list handed a remote guest read AND control over agents belonging
 * to a conversation the sharer never shared. With one conversation registered
 * there is nothing unshared to reach, and this test passes on the broken code.
 *
 * Runs over the in-memory relay and fake WebSocket the other collab suites use,
 * so the real host, socket, sealing and handshake are exercised.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { importRoomKey } from "@veyyon/coding-agent/collab/crypto";
import { CollabHost } from "@veyyon/coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@veyyon/coding-agent/collab/protocol";
import { CollabSocket } from "@veyyon/coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

/** The shared conversation this host is hosting. */
const SHARED_SESSION_ID = "sess-shared";

function makeHostContext(): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => SHARED_SESSION_ID,
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: SHARED_SESSION_ID, timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

/** Directed replies only; the host's debounced broadcasts interleave nondeterministically. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

async function joinAsGuest(link: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

/** Skip forward to the next frame of a given type. */
async function frameOfType(guest: TestGuest, type: string): Promise<CollabFrame> {
	for (let i = 0; i < 12; i++) {
		const frame = await guest.nextFrame();
		if (frame.t === type) return frame;
	}
	throw new Error(`no ${type} frame arrived`);
}

const guestCleanups: (() => void)[] = [];
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeHostContext());
	await host.start("ws://localhost:8791");
});

beforeEach(() => {
	// Other collab suites in this batch register their own agents in the same
	// process-global registry, so the roster is reset going IN as well as out.
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

/** Two conversations in the host process: the one being shared, and one that is not. */
function registerBothConversations(): void {
	const registry = AgentRegistry.global();
	const session = { messages: [] } as unknown as AgentSession;
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session,
		scope: SHARED_SESSION_ID,
	});
	registry.register({
		id: "Shared-Scout",
		displayName: "scout",
		kind: "sub",
		parentId: "Main",
		session,
		status: "running",
	});
	registry.register({
		id: "acp:private",
		displayName: "main",
		kind: "main",
		session,
		scope: "sess-private",
	});
	registry.register({
		id: "Private-Scout",
		displayName: "scout",
		kind: "sub",
		parentId: "acp:private",
		session,
		sessionFile: "/tmp/private-scout.jsonl",
		status: "running",
	});
}

describe("A collab host mirrors only the conversation it is hosting", () => {
	/**
	 * Both directions in one assertion: the shared conversation's agents are
	 * present and the unshared one's are absent. An empty list would be a
	 * different bug, not a fix.
	 */
	it("welcomes a guest with this conversation's agents and no others", async () => {
		registerBothConversations();
		const guest = await joinAsGuest(host.link);
		guestCleanups.push(() => guest.socket.close());

		const welcome = await frameOfType(guest, "welcome");
		if (welcome.t !== "welcome") throw new Error("expected welcome");

		const ids = welcome.agents.map(agent => agent.id).sort();
		expect(ids).toEqual(["Main", "Shared-Scout"]);
	});

	/**
	 * The control path, guarded independently of the snapshot. The command
	 * carries a bare id off the wire, so a stale or hostile client can name an
	 * agent it was never shown; this is the only thing between it and a session
	 * that was not shared.
	 */
	it("refuses a transcript read for an agent of an unshared conversation", async () => {
		registerBothConversations();
		const guest = await joinAsGuest(host.link);
		guestCleanups.push(() => guest.socket.close());
		await frameOfType(guest, "welcome");

		guest.socket.send({ t: "fetch-transcript", reqId: 1, agentId: "Private-Scout", fromByte: 0 });
		const reply = await frameOfType(guest, "transcript");
		if (reply.t !== "transcript") throw new Error("expected transcript");

		expect(reply.error).toBe("no transcript available");
		expect(reply.text).toBe("");
	});
});
