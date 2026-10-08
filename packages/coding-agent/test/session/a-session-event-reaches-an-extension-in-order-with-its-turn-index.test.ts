/**
 * WHY THIS SUITE EXISTS. `ExtensionEventForwarder` turns each session event into the extension event it
 * maps to and counts the turns of a run. An extension reads `turnIndex` to tell the turns of one run
 * apart, and a streamed `message_update` handler sees the message only as the order of events builds
 * it, so a forwarder that let a later event overtake a slow handler, or counted turns across runs,
 * would hand an extension a sequence the session never produced.
 *
 * THE CLASS. The turn index on every transition (`agent_start` resets it, `turn_end` advances it after
 * the handler sees the turn), the queue order under a handler that has not returned, and the default an
 * optional field takes on its way to the extension. Driven through a real `ExtensionRunner` and an
 * extension loaded from disk, so the events reach the handler an extension registers.
 *
 * WHAT IT DOES NOT CATCH. The mapping of each remaining event type field by field; a new session event
 * type the forwarder drops is not seen here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { ExtensionEventForwarder } from "@veyyon/coding-agent/session/runtime/extension-event-forwarder";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** What the recording extension pushes for each event it receives. */
interface Received {
	readonly type: string;
	readonly turnIndex?: number;
	readonly isError?: boolean;
	readonly text?: string;
}

/** Shared with the extension through `globalThis`, because the extension is a module loaded from disk. */
interface Sink {
	readonly events: Received[];
	/** While set, the `message_start` handler waits on it before recording. */
	hold: Promise<void> | undefined;
}

const SINK_KEY = "__extensionEventForwarderSink";

const RECORDER = `
export default function (pi) {
	const sink = globalThis[${JSON.stringify(SINK_KEY)}];
	for (const type of ["agent_start", "turn_start", "turn_end", "message_start", "message_end", "tool_execution_end"]) {
		pi.on(type, async event => {
			if (type === "message_start" && sink.hold) await sink.hold;
			const content = event.message?.content;
			sink.events.push({
				type,
				turnIndex: event.turnIndex,
				isError: event.isError,
				text: typeof content === "string" ? content : undefined,
			});
		});
	}
}
`;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1_756_080_000 };
}

let tempDir: TempDir;
let authStorage: AuthStorage;
let runner: ExtensionRunner;
const sink: Sink = { events: [], hold: undefined };
const globals = globalThis as Record<string, unknown>;

beforeAll(async () => {
	tempDir = TempDir.createSync("@extension-event-forwarder-");
	const projectDir = tempDir.join("project");
	fs.mkdirSync(projectDir, { recursive: true });
	// Outside the project directory, so the loader treats it as the operator's own extension.
	const extensionPath = tempDir.join("recorder.ts");
	fs.writeFileSync(extensionPath, RECORDER);
	globals[SINK_KEY] = sink;

	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const loaded = await loadExtensions([extensionPath], projectDir);
	expect(loaded.errors).toEqual([]);
	runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		projectDir,
		SessionManager.inMemory(),
		new ModelRegistry(authStorage),
	);
});

afterEach(() => {
	sink.events.length = 0;
	sink.hold = undefined;
});

afterAll(() => {
	delete globals[SINK_KEY];
	authStorage?.close();
	tempDir?.removeSync();
});

describe("a session event reaches an extension in order with its turn index", () => {
	it("numbers the turns of a run from zero and starts again on the next run", async () => {
		const forwarder = new ExtensionEventForwarder(runner);
		const reply = userMessage("reply");
		const run: AgentSessionEvent[] = [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "turn_end", message: reply, toolResults: [] },
			{ type: "turn_start" },
			{ type: "turn_end", message: reply, toolResults: [] },
		];
		for (const event of run) await forwarder.forward(event);
		expect(forwarder.turnIndex).toBe(2);
		for (const event of run) await forwarder.forward(event);

		const turns = sink.events.filter(event => event.type !== "agent_start").map(e => `${e.type}:${e.turnIndex}`);
		expect(turns).toEqual([
			"turn_start:0",
			"turn_end:0",
			"turn_start:1",
			"turn_end:1",
			"turn_start:0",
			"turn_end:0",
			"turn_start:1",
			"turn_end:1",
		]);
	});

	it("holds a later event until the handler of an earlier one has returned", async () => {
		const forwarder = new ExtensionEventForwarder(runner);
		const release = Promise.withResolvers<void>();
		sink.hold = release.promise;

		const first = forwarder.enqueue({ type: "message_start", message: userMessage("first") });
		const second = forwarder.enqueue({ type: "message_end", message: userMessage("second") });
		// Let the queue run as far as it can while the first handler waits.
		for (let tick = 0; tick < 100; tick++) await Promise.resolve();
		expect(sink.events).toEqual([]);

		release.resolve();
		await Promise.all([first, second]);
		expect(sink.events.map(event => `${event.type}:${event.text}`)).toEqual([
			"message_start:first",
			"message_end:second",
		]);
	});

	it("tells an extension a tool that reported no error state did not fail", async () => {
		const forwarder = new ExtensionEventForwarder(runner);
		await forwarder.forward({
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
		});

		expect(sink.events).toEqual([{ type: "tool_execution_end", isError: false }]);
	});

	it("forwards nothing when the session has no extension runner", async () => {
		const forwarder = new ExtensionEventForwarder(undefined);
		await forwarder.forward({ type: "agent_start" });
		await forwarder.forward({ type: "turn_start" });

		expect(sink.events).toEqual([]);
		expect(forwarder.turnIndex).toBe(0);
	});
});
