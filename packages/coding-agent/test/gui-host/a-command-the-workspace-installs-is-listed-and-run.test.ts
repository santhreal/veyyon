/**
 * WHY: the desktop drew sixteen commands compiled into its binary, so a skill,
 * an extension command, a project command file and an MCP prompt were
 * unreachable from the window while the terminal listed every one of them
 * under `/`. The catalogue is the host's, built by `gui-host/commands-view.ts`,
 * advertised as a `Commands` snapshot and run back through `RunCommand`.
 *
 * THE CLASS THIS CLOSES: a command the host can run that never reaches a
 * client, and a `CommandView` a client cannot decode. The builtin sweep reads
 * `TEXT_MODE_BUILTIN_DECLARATIONS` at run time, so a builtin added to the
 * table turns this red until it is advertised, and the shape assertion covers
 * every field the desktop's deserializer requires rather than the fields one
 * command happens to set.
 *
 * WHAT IT DOES NOT CATCH: the palette's ranking of one row against another,
 * which is the desktop's own suite, and the handlers each builtin runs, which
 * the slash-command suites drive. A command discovered off a live session
 * (skill, extension, MCP prompt) is covered by the source mapping here and by
 * `available-commands`' own tests, not by installing one in this workspace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { CommandView } from "../../src/gui-host/wire";
import { TEXT_MODE_BUILTIN_DECLARATIONS } from "../../src/slash-commands/text-mode-builtins";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

const makeTempDir = useTrackedTempDirs("gui-host-commands-test-");

/** The one catalogue a request carried. */
function catalogue(frames: RequestFrame[]): CommandView[] {
	const sections = snapshotSections<CommandView[]>(frames, "Commands");
	expect(sections.length).toBeGreaterThan(0);
	return sections[sections.length - 1] ?? [];
}

describe("the commands a workspace installs reach the desktop and run", () => {
	let tempDir: string;
	let agentDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = makeTempDir();
		agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
	});

	async function connect(): Promise<TestSocketClient> {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir });
		return await TestSocketClient.connect(server.endpoint);
	}

	/** Open a session through the wire and answer with the id the host activated. */
	async function createSession(client: TestSocketClient, id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = created.frames.find(frame => frame.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	test("ListCommands names every builtin a text client can drive", async () => {
		const client = await connect();
		const res = await client.request(1, "ListCommands");
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const listed = catalogue(res.frames).map(command => command.name);
		const declared = TEXT_MODE_BUILTIN_DECLARATIONS.map(declaration => declaration.name);
		expect(declared.filter(name => !listed.includes(name))).toEqual([]);

		client.destroy();
	});

	test("every command carries the fields the desktop deserializes", async () => {
		// WHY: `JSON.stringify` drops an `undefined` field, and the desktop's
		// `CommandView` has no defaults: a command whose description or hint
		// resolved to `undefined` crosses without the key and the frame is
		// rejected as a protocol error, taking the connection with it.
		const client = await connect();
		const res = await client.request(1, "ListCommands");

		const incomplete = catalogue(res.frames).filter(
			command =>
				typeof command.name !== "string" ||
				!Array.isArray(command.aliases) ||
				!("description" in command) ||
				!("input_hint" in command) ||
				typeof command.source !== "string" ||
				!Array.isArray(command.subcommands),
		);
		expect(incomplete).toEqual([]);

		client.destroy();
	});

	test("a builtin runs and writes what it printed into the transcript", async () => {
		const client = await connect();
		const session = await createSession(client, 1);
		const res = await client.request(2, { RunCommand: { session, text: "tools" } });
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		interface Entry {
			role?: string;
			raw_discriminator?: string;
			content?: Array<{ Text?: { text?: string } }>;
		}
		const printed = res.frames
			.flatMap(frame => (frame.TranscriptAppended?.entries ?? []) as Entry[])
			.filter(entry => entry.raw_discriminator === "command_output");
		expect(printed.length).toBeGreaterThan(0);
		expect(printed.every(entry => entry.role === "Custom")).toBe(true);
		// What the command printed is the entry's text, so the desktop draws
		// the answer rather than an empty box under the command.
		const said = printed.flatMap(entry => entry.content ?? []).map(block => block.Text?.text ?? "");
		expect(said.some(text => text.length > 0)).toBe(true);

		client.destroy();
	});

	test("a command is run by the name it was advertised under, with or without its slash", async () => {
		const client = await connect();
		const session = await createSession(client, 1);
		const bare = await client.request(2, { RunCommand: { session, text: "tools" } });
		const slashed = await client.request(3, { RunCommand: { session, text: "/tools" } });

		expect(bare.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(slashed.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		client.destroy();
	});

	test("text that is not a command is refused rather than submitted as a prompt", async () => {
		const client = await connect();
		const res = await client.request(1, { RunCommand: { session: "default", text: "" } });

		expect(res.outcome.RequestFailed?.request).toBe(1);
		expect(res.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(res.outcome.RequestFailed?.error.retryable).toBe(false);

		client.destroy();
	});

	test("an unknown command is refused by the host, not answered by the model", async () => {
		const client = await connect();
		const res = await client.request(1, {
			RunCommand: { session: "default", text: "no-such-command-here" },
		});

		expect(res.outcome.RequestFailed?.request).toBe(1);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Session");

		client.destroy();
	});
});
