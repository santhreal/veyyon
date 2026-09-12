/**
 * WHY:
 *
 * The host answers `Changes`, `FileTree`, `Usage` and `Processes` only when a
 * client asks for them, and the desktop asks once, at the handshake: the panel
 * opens, loads its tree and its change list, and nothing ever asks again. A
 * turn that edits a file, creates one, launches a process or spends a token
 * therefore left every one of those panes drawing the workspace as it stood
 * before the session's first prompt. The Changes tab listed what the operator
 * had edited by hand and never a line the agent wrote; the tree never grew the
 * file the agent created; the totals stayed at zero for the life of the
 * window. Nothing in the protocol was missing -- the host simply never spoke
 * unless spoken to.
 *
 * The class this closes: a domain a turn can change going stale for the life
 * of a connection because only a request republishes it. The census below
 * classifies every section of the snapshot union read off the host's own
 * `ALL_SNAPSHOT_SECTIONS`, so a section added later fails here until someone
 * decides whether a turn changes it.
 *
 * This suite defends:
 * 1. A turn whose tool writes a file leaves the client holding a `Changes`
 *    view naming it, with no request sent.
 * 2. The re-statement is ordered and `Usage` closes it, so a client knows a
 *    domain it did not receive is not still coming.
 * 3. A tree is re-stated to the client that loaded one and to no other, and a
 *    process list to the client that asked for one and to no other -- asking
 *    is what starts the project's supervisor, and an unasked re-statement
 *    would start a broker behind every workspace that supervises nothing.
 * 4. The totals re-stated are the ones the turn spent.
 *
 * What it does NOT catch: whether the desktop redraws a pane it is not looking
 * at, which is the window's own state store; and a second client watching the
 * same session, which is re-stated only when it asks, because the event is
 * delivered to the connection whose session emitted it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context, StopReason } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import {
	ALL_SNAPSHOT_SECTIONS,
	type ChangesView,
	type FileTreeView,
	type SnapshotSectionTag,
	type UsageView,
} from "../../src/gui-host/wire";
import { closeDaemonClients } from "../../src/launch/client";
import { daemonRuntimeDir } from "../../src/launch/paths";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, TestSocketClient } from "./test-client";

/** The file the turn's tool writes, so the workspace changes while the turn runs. */
const WRITTEN = "agent-wrote-this.txt";
const WRITTEN_BODY = "the agent put this here\n";
/** A file committed before the session opens, so the tree and the index are not empty. */
const COMMITTED = "committed.txt";

/**
 * What the host does with each snapshot section when a turn ends, over the
 * union the host itself declares. `Record` over the tag union, so a section
 * added to the wire fails `check:ts` here until it is classified, and the
 * runtime sweep below fails if the union grows without this table.
 *
 * - `restated-at-idle`: a turn changes it, so the workspace re-statement
 *   publishes it unasked.
 * - `listed-at-idle`: the session index, re-stated by its own path and owned
 *   by `a-turn-that-ends-stops-being-listed-as-running.test.ts`.
 * - `during-turn`: the turn's own frames carry it; nothing is owed at idle.
 * - `on-request`: a turn does not change it, or the client reads it once.
 */
const AT_IDLE: Record<SnapshotSectionTag, "restated-at-idle" | "listed-at-idle" | "during-turn" | "on-request"> = {
	Sessions: "listed-at-idle",
	ActiveSession: "during-turn",
	Transcript: "during-turn",
	SessionSearch: "on-request",
	SessionTranscript: "on-request",
	Capabilities: "on-request",
	Interactions: "during-turn",
	Settings: "on-request",
	Diagnostics: "on-request",
	Changes: "restated-at-idle",
	FileTree: "restated-at-idle",
	FileContent: "on-request",
	SearchResults: "on-request",
	ContentMatches: "on-request",
	Terminals: "on-request",
	TerminalOutput: "on-request",
	Processes: "restated-at-idle",
	ProcessLogs: "on-request",
	Models: "during-turn",
	Providers: "on-request",
	AuthFlow: "on-request",
	Mcp: "on-request",
	Agents: "on-request",
	Usage: "restated-at-idle",
	ContextBreakdown: "on-request",
	Export: "on-request",
	Themes: "on-request",
	Keybindings: "on-request",
	QueuedPrompts: "during-turn",
};

/** The section the host publishes last, which is what closes a re-statement. */
const CLOSES_THE_RESTATEMENT: SnapshotSectionTag = "Usage";

function assistantMessage(text: string, stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason,
		usage: {
			input: 120,
			output: 34,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 154,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		timestamp: Date.now(),
	};
}

function endedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text, "stop");
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

/**
 * A reply that writes a file and ends the turn on the call. The tool is the
 * session's own `write`, which the suite's `auto` approval rung runs unasked,
 * so the file lands the way a real turn lands one.
 */
function writeFileStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const call = {
		type: "toolCall",
		id: "call-write-1",
		name: "write",
		arguments: { path: WRITTEN, content: WRITTEN_BODY },
	} as const;
	const message: AssistantMessage = { ...assistantMessage("", "toolUse"), content: [call] };
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
	});
	return stream;
}

/** A title request carries one `<user>`-wrapped message; a turn's carries the session's. */
function isTitleRequest(context: Context): boolean {
	if (context.messages.length !== 1) return false;
	const content = context.messages[0]?.content;
	return typeof content === "string" && content.startsWith("<user>");
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
	await proc.exited;
}

describe("a domain a turn changes is re-stated when the agent goes idle", () => {
	/** The root both directories live under, removed whole in `afterEach`. */
	let tempDir: string;
	/** The workspace the host runs in: a repository holding nothing but its files. */
	let workDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** How many requests the stubbed provider answered for a turn, not a title. */
	let turnRequests: number;

	beforeEach(async () => {
		// A session initializes the process-wide settings singleton, and one left
		// over from another file resolves against a directory this one does not
		// own. Cleared on both sides.
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-restate-"));
		// The agent's own directory sits outside the repository, as it does in
		// the product: a session file or a credential store inside the workspace
		// would list as a change the agent made.
		const agentDir = path.join(tempDir, "agent");
		workDir = path.join(tempDir, "work");
		await fs.mkdir(workDir);
		await fs.mkdir(computeDefaultSessionDir(workDir, new FileSessionStorage(), path.join(agentDir, "sessions")), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			"modelRoles:\n  default: openai/gpt-4o-mini\ntools:\n  approvalMode: auto\n",
			"utf8",
		);

		await git(workDir, "init");
		await git(workDir, "config", "user.name", "Test User");
		await git(workDir, "config", "user.email", "test@example.com");
		await fs.writeFile(path.join(workDir, COMMITTED), "committed\n", "utf8");
		await git(workDir, "add", COMMITTED);
		await git(workDir, "commit", "-m", "initial commit");

		const authStorage = await isolatedAuthStorage(agentDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		turnRequests = 0;
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			if (isTitleRequest(context)) return endedStream("<title>A title</title>");
			turnRequests += 1;
			if (turnRequests === 1) return writeFileStream();
			return endedStream("Wrote the file.");
		});

		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: workDir, agentDir, authStorage });
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await closeDaemonClients();
		resetSettingsForTest();
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup error
		}
	});

	/** Create a session through the wire and answer with the id the host activated. */
	async function createSession(id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	/**
	 * Every frame from the prompt through the section that closes the host's
	 * re-statement, split at the reply clearing.
	 *
	 * Bounded, so a re-statement that never comes fails as the named error --
	 * which is the shape of the defect: the pane waits forever for a snapshot
	 * nothing will send.
	 */
	async function promptUntilRestated(session: string, id: number): Promise<{ afterIdle: RequestFrame[] }> {
		const submitted = await client.request(id, { SubmitPrompt: { session, text: "please write the file" } });
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: id } });

		const frames: RequestFrame[] = [...submitted.frames];
		for (let read = 0; read < 400; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			if (frame.RequestFailed) throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			frames.push(frame);
			if (frame.Snapshot && CLOSES_THE_RESTATEMENT in frame.Snapshot) {
				const cleared = frames.findLastIndex(f => "StreamingChanged" in f && f.StreamingChanged === null);
				expect(cleared).toBeGreaterThanOrEqual(0);
				return { afterIdle: frames.slice(cleared + 1) };
			}
		}
		throw new Error(`the workspace was never re-stated: no ${CLOSES_THE_RESTATEMENT} within 400 frames`);
	}

	/** The section tags carried by `frames`, in the order they arrived. */
	function sectionsOf(frames: RequestFrame[]): SnapshotSectionTag[] {
		return frames.flatMap(frame => (frame.Snapshot ? (Object.keys(frame.Snapshot) as SnapshotSectionTag[]) : []));
	}

	function lastSection<T>(frames: RequestFrame[], section: SnapshotSectionTag): T | undefined {
		const found = frames.filter(frame => frame.Snapshot && section in frame.Snapshot).at(-1);
		return found?.Snapshot?.[section] as T | undefined;
	}

	test("the file a turn's tool wrote is stated to a client that asked for nothing", async () => {
		const session = await createSession(1);
		const { afterIdle } = await promptUntilRestated(session, 2);

		// The turn really wrote it: the tool ran mid-loop, and the session asked
		// the provider again once it had.
		expect(await fs.readFile(path.join(workDir, WRITTEN), "utf8")).toBe(WRITTEN_BODY);
		expect(turnRequests).toBeGreaterThanOrEqual(2);

		const changes = lastSection<ChangesView>(afterIdle, "Changes");
		expect(changes).toBeDefined();
		expect(changes?.scope).toBe("WorkingTree");
		expect(changes?.files.map(file => file.path)).toEqual([WRITTEN]);
		expect(changes?.files[0]?.status).toBe("Untracked");
	});

	test("the totals re-stated are the ones the turn spent, and they close the re-statement", async () => {
		const session = await createSession(1);
		const { afterIdle } = await promptUntilRestated(session, 2);

		const pushed = lastSection<UsageView>(afterIdle, "Usage");
		expect(pushed?.session).toBe(session);
		// The turn spent tokens, and what arrived unasked is what asking would
		// answer: equality against the requested view, so a re-statement built
		// from a stale or empty reading fails.
		expect(pushed?.totals.input_tokens).toBeGreaterThan(0);
		expect(pushed?.totals.output_tokens).toBeGreaterThan(0);
		const asked = lastSection<UsageView>((await client.request(3, { GetUsage: { session } })).frames, "Usage");
		expect(pushed?.totals).toEqual(asked?.totals);

		// Nothing the re-statement owes follows the totals, so a domain that has
		// not arrived by then is not coming.
		const republished = sectionsOf(afterIdle).filter(tag => AT_IDLE[tag] === "restated-at-idle");
		expect(republished.at(-1)).toBe(CLOSES_THE_RESTATEMENT);
	});

	test("the tree is re-stated to the client that loaded one, and grows the file the turn created", async () => {
		const session = await createSession(1);
		const loaded = await client.request(2, { LoadFileTree: {} });
		expect(loaded.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const { afterIdle } = await promptUntilRestated(session, 3);
		const tree = lastSection<FileTreeView>(afterIdle, "FileTree");
		expect(tree).toBeDefined();
		expect(tree?.entries.map(entry => entry.path)).toContain(WRITTEN);
	});

	test("a client that loaded no tree and asked for no processes is sent neither", async () => {
		const session = await createSession(1);
		const { afterIdle } = await promptUntilRestated(session, 2);

		// The re-statement is ordered and closed by the totals, so the absence
		// here is decided, not a snapshot that had not arrived yet.
		const restated = sectionsOf(afterIdle);
		expect(restated).toContain("Changes");
		expect(restated).not.toContain("FileTree");
		expect(restated).not.toContain("Processes");

		// And no supervisor was started behind a workspace that supervises
		// nothing: a broker writes its runtime directory the moment it binds.
		expect(await fs.readdir(daemonRuntimeDir(workDir)).catch(() => null)).toBeNull();
	});

	test("the process list is re-stated to the client that asked for one", async () => {
		const session = await createSession(1);
		const listed = await client.request(2, "RefreshProcesses");
		expect(listed.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const { afterIdle } = await promptUntilRestated(session, 3);
		expect(sectionsOf(afterIdle)).toContain("Processes");
	});

	test("every section of the snapshot union is classified, and the idle ones are the ones re-stated", async () => {
		// Derived from the host's own union rather than written down twice: a
		// section added to the wire is absent here and fails.
		expect(Object.keys(AT_IDLE).sort()).toEqual([...ALL_SNAPSHOT_SECTIONS].sort());

		const owedAtIdle = ALL_SNAPSHOT_SECTIONS.filter(tag => AT_IDLE[tag] === "restated-at-idle");
		expect(owedAtIdle).toEqual(["Changes", "FileTree", "Processes", "Usage"]);

		// A client holding every domain a turn can change receives every
		// classified one once the agent is idle, and nothing the table calls
		// request-only: a section that starts arriving unasked fails here, and
		// one that stops arriving fails too.
		const session = await createSession(1);
		await client.request(2, { LoadFileTree: {} });
		await client.request(3, "RefreshProcesses");
		const { afterIdle } = await promptUntilRestated(session, 4);

		const restated = new Set(sectionsOf(afterIdle));
		expect(owedAtIdle.filter(tag => restated.has(tag))).toEqual(owedAtIdle);
		expect([...restated].filter(tag => AT_IDLE[tag] === "on-request")).toEqual([]);
	});
});
