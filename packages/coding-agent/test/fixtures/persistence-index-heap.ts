/**
 * Builds `MessagePersistence`'s branch index over an in-memory session of argv[2] logged messages
 * and prints, as JSON, the heap and external bytes the index retains once built.
 *
 * Runs in its own process: the measurement reads the whole heap, and in a test runner process the
 * files run before it leave garbage that dies or stays alive across the window.
 */
import { heapStats } from "bun:jsc";
import type { Message } from "@veyyon/ai";
import { MessagePersistence } from "@veyyon/coding-agent/session/runtime/message-persistence";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem } from "@veyyon/utils";

export interface PersistenceIndexHeap {
	/** Messages on the branch the index covers. */
	messages: number;
	/** Heap and external bytes the built index retains over the session it indexes. */
	retained: number;
}

function retained(): number {
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

/** A logged message per index, cycling through the roles a key covers, each with a provider-length id. */
function message(index: number): Message {
	const timestamp = 1_760_000_000_000 + index * 37;
	const id = `toolu_01${index.toString(36).padStart(22, "x")}`;
	switch (index % 3) {
		case 0:
			return { role: "user", content: `turn ${index}`, timestamp };
		case 1:
			return {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				responseId: `msg_01${index.toString(36).padStart(22, "y")}`,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp,
			};
		default:
			return { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp };
	}
}

/** A session of `count` logged messages and the persistence that indexes it, branch already walked once. */
function session(count: number): { store: SessionManager; persistence: MessagePersistence } {
	const store = SessionManager.inMemory();
	for (let index = 0; index < count; index++) store.appendMessage(message(index));
	store.getBranch();
	const persistence = new MessagePersistence({
		sessionStore: store,
		instrumentationLevel: () => "off",
		pendingContextSnapshot: () => undefined,
		nonMessageTokens: () => 0,
		consumeRewoundResult: () => false,
		onTtsrInjectionPersisted: () => {},
	});
	return { store, persistence };
}

function measure(count: number): PersistenceIndexHeap {
	const probe = message(count * 2);
	// A first index of the same size compiles every function the measured build runs.
	const warm = session(count);
	if (warm.persistence.alreadyPersisted(probe)) throw new Error("the probe is not on the warm-up branch");
	const measured = session(count);
	const before = retained();
	if (measured.persistence.alreadyPersisted(probe)) throw new Error("the probe is not on the measured branch");
	const grown = retained() - before;
	// Both sessions stay reachable until both readings are taken.
	if (warm.store.getBranch().length !== count || measured.store.getBranch().length !== count) {
		throw new Error("a session lost an entry");
	}
	return { messages: count, retained: grown };
}

try {
	const count = Number(process.argv[2]);
	if (!Number.isInteger(count) || count <= 0) throw new Error("usage: persistence-index-heap.ts <messages>");
	process.stdout.write(`${JSON.stringify(measure(count))}\n`);
} finally {
	await postmortem.cleanup();
}
