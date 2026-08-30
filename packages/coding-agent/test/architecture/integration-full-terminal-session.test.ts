/**
 * WHY: steps 3 to 5 of the decoupling are three modules that each pass their own
 * suite while composing into nothing. The contract in `@veyyon/wire/presentation`
 * is checked against a reference implementation, the builders are checked against
 * hand-built inputs, and the driver is checked against hand-built view-models —
 * so every one of them can be green while a real agent turn reaches the terminal
 * as an empty frame.
 *
 * This is the suite that refuses that outcome. One real `AgentSession`, over the
 * real `Agent` loop, with the real `read` tool against a real temp directory and
 * only the model scripted, feeds a real `PresentationEventBridge` into a real
 * `TerminalPresentationDriver` on Ghostty's VT. The assertions read the terminal
 * viewport, so a block that never becomes rows, an event that never becomes a
 * block, and a zone that never mounts all fail here.
 *
 * Closes the class of: a seam that is wired in a type and dead at run time.
 *
 * What it does NOT catch: colour fidelity (the probe picks a 256-colour encoding
 * whose RGB the harness cannot read back), and provider-side streaming shapes,
 * since the model is scripted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { BUILTIN_TOOLS } from "@veyyon/coding-agent/tools/index";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import type { UIEvent } from "@veyyon/wire/presentation";
import { settleFrames } from "../../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../hosts/terminal/engine/test/virtual-terminal";
import { TerminalPresentationDriver } from "../../src/modes/terminal/driver";
import { PresentationEventBridge } from "../../src/presentation/event-bridge";
import { makeToolSession } from "../helpers/tool-session";
import { testTheme } from "./helpers/presentation-theme";

const WIDTH = 80;
const HEIGHT = 24;
const TEST_PARENT = path.resolve(import.meta.dirname, "../../../../.internal/full-terminal-session");

interface Rig {
	cwd: string;
	session: AgentSession;
	bridge: PresentationEventBridge;
	driver: TerminalPresentationDriver;
	terminal: VirtualTerminal;
	events: UIEvent[];
	viewport(): string;
	dispose(): Promise<void>;
}

/** Everything below the model is real; only the model's turns are scripted. */
async function createRig(options: {
	script: ReadonlyArray<{ content: ReadonlyArray<string | Record<string, unknown>> }>;
	files?: Record<string, string>;
}): Promise<Rig> {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	const cwd = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));

	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd, overrides: { "startup.quiet": true } });

	for (const [relative, contents] of Object.entries(options.files ?? {})) {
		const absolute = path.join(cwd, relative);
		await fs.mkdir(path.dirname(absolute), { recursive: true });
		await fs.writeFile(absolute, contents);
	}

	const readTool = await BUILTIN_TOOLS.read(makeToolSession({ cwd }));
	if (!readTool) throw new Error("Expected the builtin read tool to construct for this workspace");

	const model = createMockModel({ responses: options.script as never });
	const agent = new Agent({
		streamFn: model.stream,
		initialState: { model, systemPrompt: ["full terminal session"], tools: [readTool], messages: [] },
	});

	const authStorage = await AuthStorage.create(path.join(cwd, "testauth.db"));
	// The session refuses to prompt a provider it has no credential for, which is
	// production behaviour and not something to bypass: give the mock one.
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(cwd, cwd),
		settings: Settings.isolated({ "startup.quiet": true }),
		modelRegistry: new ModelRegistry(authStorage),
	});

	const terminal = new VirtualTerminal(WIDTH, HEIGHT);
	const driver = new TerminalPresentationDriver(terminal, { theme: testTheme() });
	const events: UIEvent[] = [];
	driver.onInput(event => {
		events.push(event);
	});
	driver.start();

	const bridge = new PresentationEventBridge(session, driver);
	bridge.connect();

	return {
		cwd,
		session,
		bridge,
		driver,
		terminal,
		events,
		viewport: () => terminal.getViewport().join("\n"),
		async dispose(): Promise<void> {
			bridge.disconnect();
			driver.stop();
			await session.dispose();
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
			resetSettingsForTest();
		},
	};
}

describe("a real agent turn reaches the terminal through the presentation seam", () => {
	let rig: Rig | undefined;

	beforeEach(() => {
		rig = undefined;
	});

	afterEach(async () => {
		await rig?.dispose();
		rig = undefined;
	});

	test("the prompt, the tool call, its real result and the reply all paint", async () => {
		rig = await createRig({
			files: { "src/config.ts": "export const PORT = 8080;\n" },
			script: [
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "src/config.ts" } }] },
				{ content: ["PORT is 8080"] },
			],
		});

		await rig.session.prompt("what port does src/config.ts use");
		await settleFrames(rig.terminal, rig.driver.tui);

		const frame = rig.viewport();
		// The prompt text itself: the bridge seeded and followed the transcript.
		expect(frame).toContain("what port does src/config.ts use");
		// The tool the model asked for, by name, from a toolCall block.
		expect(frame).toContain("read");
		// The assistant's closing turn, which only exists if message_end landed.
		expect(frame).toContain("PORT is 8080");

		// The tool actually ran against the real file rather than being scripted:
		// the result the model was handed carries the file's bytes.
		const results = rig.session.messages.filter(message => message.role === "toolResult");
		expect(results.length).toBe(1);
		expect(JSON.stringify(results[0])).toContain("PORT = 8080");
	});

	test("a second turn appends to the transcript instead of replacing it", async () => {
		rig = await createRig({
			script: [{ content: ["first"] }, { content: ["second"] }],
		});

		await rig.session.prompt("one");
		await settleFrames(rig.terminal, rig.driver.tui);
		expect(rig.viewport()).toContain("first");

		await rig.session.prompt("two");
		await settleFrames(rig.terminal, rig.driver.tui);

		const frame = rig.viewport();
		expect(frame).toContain("first");
		expect(frame).toContain("second");
		expect(frame).toContain("one");
		expect(frame).toContain("two");
	});

	test("a streaming assistant turn patches one block rather than appending one per delta", async () => {
		rig = await createRig({ script: [{ content: ["alpha beta gamma"] }] });

		await rig.session.prompt("stream please");
		await settleFrames(rig.terminal, rig.driver.tui);

		const frame = rig.viewport();
		// One occurrence, not one per streamed delta: block identity held from
		// message_start to message_end.
		const occurrences = frame.split("alpha beta gamma").length - 1;
		expect(occurrences).toBe(1);
	});

	test("the composer and the status line stay mounted below a live transcript", async () => {
		rig = await createRig({ script: [{ content: ["done"] }] });

		rig.driver.setComposerState({
			mode: "input",
			text: "next question",
			cursorOffset: 13,
			placeholder: "",
			attachments: [],
			queueOnSubmit: false,
		});
		rig.driver.setStatusLine({
			activity: "idle",
			model: "mock-model",
			context: { used: 0, total: 200000, providerReported: false },
			cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalUsd: 0 },
			workingDirectory: "~/work",
			elapsedMs: 0,
			queuedMessages: 0,
		});

		await rig.session.prompt("go");
		await settleFrames(rig.terminal, rig.driver.tui);

		const frame = rig.viewport();
		expect(frame).toContain("done");
		expect(frame).toContain("next question");
		expect(frame).toContain("mock-model");
	});

	test("a keystroke on the live terminal leaves as a UIEvent", async () => {
		rig = await createRig({ script: [{ content: ["ok"] }] });

		await rig.session.prompt("hi");
		await settleFrames(rig.terminal, rig.driver.tui);

		rig.terminal.sendInput("\x03");
		await settleFrames(rig.terminal, rig.driver.tui);

		expect(rig.events.map(event => event.type)).toContain("interrupt");
	});
});
