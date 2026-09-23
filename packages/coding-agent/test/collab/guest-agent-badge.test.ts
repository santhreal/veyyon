import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateRoomKey, importRoomKey } from "@veyyon/coding-agent/collab/crypto";
import { CollabGuestLink } from "@veyyon/coding-agent/collab/guest";
import type { CollabGuestSession, CollabGuestSurface } from "@veyyon/coding-agent/collab/guest-surface";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
} from "@veyyon/coding-agent/collab/protocol";
import { CollabSocket } from "@veyyon/coding-agent/collab/relay-client";
import {
	countRunningAgentBadgeAgents,
	getRunningAgentBadgeRegistry,
} from "@veyyon/coding-agent/modes/terminal/running-agent-badge";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), mirroring the relay's forwarding contract.

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

function makeAgents(ids: string[]): AgentSnapshot[] {
	return ids.map((id, index) => ({
		id,
		displayName: `Remote ${index + 1}`,
		kind: "sub",
		parentId: "Main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1000 + index,
		lastActivity: 2000 + index,
	}));
}

function makeGuestSurface(counts: number[]): {
	surface: CollabGuestSurface;
	getAgentCount: () => number;
	getCollabGuest: () => CollabGuestSession | undefined;
	onSecondSnapshot: () => Promise<void>;
} {
	let statusLineCount = 0;
	let collabGuest: CollabGuestSession | undefined;
	const { promise: secondSnapshotPromise, resolve: secondSnapshotResolve } = Promise.withResolvers<void>();

	const surface: CollabGuestSurface = {
		settings: { get: () => "" } as unknown as CollabGuestSurface["settings"],
		sessionManager: {
			getSessionFile: () => null,
		} as unknown as CollabGuestSurface["sessionManager"],
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		} as unknown as CollabGuestSurface["session"],
		handleEvent: () => {},
		setGuestLink: link => {
			collabGuest = link;
		},
		redrawSession: () => Promise.resolve(),
		setSessionTitle: () => {},
		clearTransientState: () => {},
		resetObservers: () => {},
		agentsChanged: () => {
			const registry = getRunningAgentBadgeRegistry(collabGuest as CollabGuestLink | undefined);
			const count = countRunningAgentBadgeAgents(registry);
			statusLineCount = count;
			counts.push(count);
			if (count === 2) secondSnapshotResolve();
		},
		setHostStreaming: () => {},
		setCollabStatus: () => {},
		setConnected: () => {},
		showStatus: () => {},
		showError: () => {},
		askGuest: () => Promise.resolve(undefined),
		restoreSession: () => Promise.resolve(),
	};

	return {
		surface,
		getAgentCount: () => statusLineCount,
		getCollabGuest: () => collabGuest,
		onSecondSnapshot: () => secondSnapshotPromise,
	};
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest running-agents badge", () => {
	it("uses the guest mirror registry and refreshes on join, resnapshot, and leave", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const roomId = "badge-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		let nextWelcomeAgents = makeAgents(["remote-one"]);
		const sendWelcome = (agents: AgentSnapshot[]) => {
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents,
				entryCount: 0,
			});
		};
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") sendWelcome(nextWelcomeAgents);
		};
		hostSocket.connect();
		await hostOpen.promise;

		const counts: number[] = [];
		const { surface, getAgentCount, getCollabGuest, onSecondSnapshot } = makeGuestSurface(counts);
		const guest = new CollabGuestLink(surface);

		try {
			await guest.join(link);
			expect(getCollabGuest()).toBe(guest);
			expect(counts).toEqual([0, 1]);
			expect(getAgentCount()).toBe(1);

			nextWelcomeAgents = makeAgents(["remote-one", "remote-two"]);
			const secondSnapshot = onSecondSnapshot();
			sendWelcome(nextWelcomeAgents);
			await secondSnapshot;
			expect(getAgentCount()).toBe(2);

			await guest.leave("test cleanup");
			expect(getCollabGuest()).toBeUndefined();
			expect(getAgentCount()).toBe(0);
			expect(counts.at(-1)).toBe(0);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
