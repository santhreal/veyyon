/**
 * WHY: `/debug` opened a terminal selector and nothing else, so a window had
 * no way to take a report bundle, a heap snapshot, the recent logs or the
 * system details — the things a defect report is built from — and the desktop
 * decision for the command read "no debug tools surface". Ten of the thirteen
 * tools read nothing of the terminal; the other three probe the terminal's
 * protocols, state its geometry and export the TUI transcript, and a host
 * that is not a terminal has nothing to run them against.
 *
 * THE CLASS THIS CLOSES: a tool offered on one host and unreachable on the
 * other. The sweep is over `DEBUG_TOOLS` at run time rather than a list
 * written here, so a tool added to the table is run by this suite or refused
 * by it: a new `any` tool that no host answers turns it red, and so does a
 * new `terminal` tool a window would be told to run. The one tool the sweep
 * cannot run is pinned by exact equality with its reason, so skipping a
 * second one is a change somebody makes on purpose.
 *
 * WHAT IT DOES NOT CATCH: how the window draws the output, which arrives as
 * the same `command_output` entry every other command's output does and is
 * the desktop's own to draw; and whether the report bundle a tool wrote holds
 * the right files, which `report-bundle` owns.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEBUG_TOOLS, HOST_DEBUG_TOOLS } from "../../src/debug/host-tools";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { PendingDecisions, TranscriptEntry } from "../../src/gui-host/wire";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/**
 * The tools this suite runs for real, and the one it does not.
 *
 * `remote-debugger` opens JavaScriptCore's inspector socket for the life of
 * the process and `bun:jsc` offers no way to close it, so running it here
 * would leave a listening socket behind for every later file in the run.
 */
const UNEXERCISED = ["remote-debugger"];

/** The output a command's run appended, or undefined when it appended none. */
function commandOutput(frames: RequestFrame[]): string | undefined {
	const entries = frames.flatMap(frame => (frame.TranscriptAppended?.entries ?? []) as TranscriptEntry[]);
	const output = entries.filter(entry => entry.raw_discriminator === "command_output");
	const last = output[output.length - 1];
	if (!last) return undefined;
	return last.content.flatMap(block => ("Text" in block ? [block.Text.text] : [])).join("");
}

describe("a window runs the debug tools that do not read the terminal", () => {
	useIsolatedConfigRoot();

	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient | null = null;
	let session = "";
	let next = 2;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-debug-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		const created = await client.request(1, { CreateSession: {} });
		const active = created.frames.find(frame => frame.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		session = active.Snapshot.ActiveSession.value.id;
		next = 2;
	});

	afterEach(async () => {
		client?.destroy();
		client = null;
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Run `/debug <args>`, answering with the first option of any decision it
	 * raises, and collect every frame the host sent for it.
	 *
	 * Two tools ask before they act — the CPU profile runs until the issue has
	 * been reproduced, and clearing the cache deletes files — so a sweep that
	 * never answered would wait out its own deadline on the first of them.
	 */
	async function debugCommand(args: string): Promise<{ frames: RequestFrame[]; outcome: RequestFrame }> {
		if (!client) throw new Error("the window is not connected");
		const id = next++;
		const text = args ? `/debug ${args}` : "/debug";
		client.send({ id, action: { RunCommand: { session, text } } });
		const frames: RequestFrame[] = [];
		const answered = new Set<string>();
		for (;;) {
			const frame = (await client.nextFrame()) as RequestFrame;
			frames.push(frame);
			if (frame.RequestSucceeded?.request === id || frame.RequestFailed?.request === id) {
				return { frames, outcome: frame };
			}
			const pending = snapshotSections<{ pending: PendingDecisions }>([frame], "Interactions");
			for (const question of pending[pending.length - 1]?.pending.questions ?? []) {
				if (answered.has(question.id)) continue;
				answered.add(question.id);
				client.send({
					id: next++,
					action: { RespondToInteraction: { session, interaction_id: question.id, response: { option: 0 } } },
				});
			}
		}
	}

	test("a tool that reads the terminal is refused by name, and every one of them is", async () => {
		const terminalOnly = DEBUG_TOOLS.filter(tool => tool.hosts === "terminal");
		expect(terminalOnly.length).toBeGreaterThan(0);
		for (const tool of terminalOnly) {
			const { outcome } = await debugCommand(tool.id);
			expect(outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
			expect(outcome.RequestFailed?.error.message).toContain("terminal");
		}
	});

	test("a word that names no tool is refused with the tools there are", async () => {
		const { outcome } = await debugCommand("not-a-tool");
		expect(outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(outcome.RequestFailed?.error.message).toContain("system");
	});

	test("every tool the host offers runs, and none of them is refused as unknown", async () => {
		const runnable = HOST_DEBUG_TOOLS.filter(tool => !UNEXERCISED.includes(tool.id));
		expect(HOST_DEBUG_TOOLS.filter(tool => UNEXERCISED.includes(tool.id)).map(tool => tool.id)).toEqual(UNEXERCISED);
		for (const tool of runnable) {
			const { frames, outcome } = await debugCommand(tool.id);
			// A tool that ran states what it did; a tool that failed reports as
			// the tool it is. Neither is the refusal a window gets for a word
			// that reaches nothing, which is what an unwired tool would give.
			const failure = outcome.RequestFailed?.error;
			if (failure) {
				expect([tool.id, failure.code]).toEqual([tool.id, "DEBUG_TOOL_FAILED"]);
				continue;
			}
			expect([tool.id, commandOutput(frames)?.length ?? 0]).not.toEqual([tool.id, 0]);
		}
	}, 120_000);

	test("the session that sent no provider frames states that none were captured", async () => {
		const { frames } = await debugCommand("raw-sse");
		expect(commandOutput(frames)).toContain("No provider frames");
	});

	test("the bare command asks which tool to run, and runs the one that is answered", async () => {
		if (!client) throw new Error("the window is not connected");
		const runId = next++;
		client.send({ id: runId, action: { RunCommand: { session, text: "/debug" } } });

		// The request stays open while the window is asked, so the question is
		// read off the stream rather than out of the request's own frames.
		let question: PendingDecisions["questions"][number] | undefined;
		const frames: RequestFrame[] = [];
		for (let read = 0; read < 40 && !question; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			frames.push(frame);
			const pending = snapshotSections<{ pending: PendingDecisions }>([frame], "Interactions");
			question = pending[pending.length - 1]?.pending.questions[0];
		}
		if (!question) throw new Error("the bare command raised no question");
		expect(question.options).toEqual(HOST_DEBUG_TOOLS.map(tool => tool.label));

		const chosen = HOST_DEBUG_TOOLS.findIndex(tool => tool.id === "raw-sse");
		client.send({
			id: next++,
			action: {
				RespondToInteraction: { session, interaction_id: question.id, response: { option: chosen } },
			},
		});
		for (;;) {
			const frame = (await client.nextFrame()) as RequestFrame;
			frames.push(frame);
			if (frame.RequestSucceeded?.request === runId || frame.RequestFailed?.request === runId) break;
		}
		expect(frames.find(frame => frame.RequestFailed?.request === runId)).toBeUndefined();
		expect(commandOutput(frames)).toContain("No provider frames");
	});
});
