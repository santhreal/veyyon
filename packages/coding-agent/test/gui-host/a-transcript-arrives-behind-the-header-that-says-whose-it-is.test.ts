/**
 * WHY: the `Transcript` snapshot section carries a bare list of entries and no
 * session id (`wire.ts`), so the desktop files one under the last
 * `ActiveSession` header it received (`reducer/snapshot.rs`). `LoadTranscript`
 * activated the requested session on the host and then sent the entries with
 * no header, so the desktop wrote one session's transcript into the pane of
 * the session the operator was reading, and every append after it addressed
 * the wrong session. `ExportSession` switched the active session the same way
 * and stated nothing at all.
 *
 * CLASS CLOSED: an action that sends a transcript, or that changes which
 * session the host is on, without a header naming that session. Every action
 * tag is swept from `ALL_HOST_ACTIONS` at run time through a
 * `Record<HostActionTag, …>` argument table, so a new action fails the type
 * check until it is given arguments and a decision. For each response: no
 * `Transcript` may appear before an `ActiveSession`, the header in front of a
 * transcript must name the session whose entries follow, and the set of
 * actions that carry a transcript at all is pinned by exact equality.
 *
 * Not caught: an action that switches the host's session and sends nothing
 * belonging to it — no frame of the protocol reveals the switch, so the
 * divergence is invisible from a client until the next transcript, which this
 * suite does catch. The desktop's own handling of a session the host stopped
 * listing is in `a-session-the-host-stopped-listing-is-not-still-the-one-in-hand.rs`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { ALL_HOST_ACTIONS, type GuiHostServer, type HostActionTag, startGuiHostServer } from "../../src/gui-host";
import { type RequestFrame, TestSocketClient } from "./test-client";

/** A session header as the host states it. */
interface HeaderSection {
	value: { id: string; title: string | null };
}

/** A transcript entry, read for the text an operator would recognise. */
interface EntrySection {
	value: Array<{ role: string; content: Array<{ Text?: { text: string }; type?: string; text?: string }> }>;
}

/**
 * The tags whose handlers may carry a transcript, pinned by exact membership.
 *
 * An action outside this set that carries one turns the sweep red: either it
 * states the header first and belongs here, or it is the defect this suite
 * closes.
 */
const MAY_CARRY_A_TRANSCRIPT: HostActionTag[] = [
	"OpenSession",
	"CreateSession",
	"LoadTranscript",
	"BranchSession",
	"CompactSession",
	"HandoffSession",
	"ClearOutput",
];

/** The tags that carry one whatever the environment offers a turn. */
const ALWAYS_CARRY_A_TRANSCRIPT: HostActionTag[] = ["OpenSession", "CreateSession", "LoadTranscript"];

/** The tag that ends the connection, so it is swept last. */
const ENDS_THE_CONNECTION: HostActionTag = "Shutdown";

/** The tag that reconnects the transport, which a client owns rather than an operator. */
const REATTACHES: HostActionTag = "Attach";

/** The text of a user entry, whichever content shape the conversion produced. */
function userTexts(section: EntrySection): string[] {
	return section.value
		.filter(entry => entry.role === "User")
		.flatMap(entry =>
			entry.content.map(block => block.Text?.text ?? (block.type === "text" ? (block.text ?? "") : "")),
		)
		.filter(text => text.length > 0);
}

/** The sections one frame carries, in the order the host sent them. */
function sectionsOf(frames: RequestFrame[]): Array<{ tag: string; value: unknown }> {
	return frames
		.filter((frame): frame is RequestFrame & { Snapshot: Record<string, unknown> } => Boolean(frame.Snapshot))
		.flatMap(frame => Object.entries(frame.Snapshot).map(([tag, value]) => ({ tag, value })));
}

describe("a transcript arrives behind the header that says whose it is", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let alpha: string;
	let beta: string;

	/** Writes one session holding one user message, and returns its id. */
	async function seed(text: string): Promise<string> {
		const storage = new FileSessionStorage();
		const sessionDir = computeDefaultSessionDir(tempDir, storage, path.join(tempDir, "sessions"));
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 });
		// The listing the host resolves an id through reads the directory, so a
		// seeded session is on disk before the window can name it.
		await sm.ensureOnDisk();
		await sm.flush();
		return sm.getSessionId();
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-header-order-test-"));
		alpha = await seed("alpha only");
		beta = await seed("beta only");
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir });
		client = await TestSocketClient.connect(server.endpoint);
		// Greeting and capabilities.
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("resuming a session states its header before its entries, and the entries are that session's", async () => {
		const opened = await client.request(1, { OpenSession: { session: alpha } });
		expect(opened.outcome).toEqual({ RequestSucceeded: { request: 1 } });

		// The defect: the transcript of another session, with no header, into
		// the pane the operator is reading.
		const loaded = await client.request(2, { LoadTranscript: { session: beta, before: null } });
		expect(loaded.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const sections = sectionsOf(loaded.frames);
		const header = sections.findIndex(section => section.tag === "ActiveSession");
		const transcript = sections.findIndex(section => section.tag === "Transcript");
		expect(header).toBeGreaterThanOrEqual(0);
		expect(transcript).toBeGreaterThan(header);
		expect((sections[header].value as HeaderSection).value.id).toBe(beta);
		expect(userTexts(sections[transcript].value as EntrySection)).toEqual(["beta only"]);
	});

	test("an export of another session states the header of the session it switched to", async () => {
		await client.request(1, { OpenSession: { session: alpha } });

		const exported = await client.request(2, { ExportSession: { session: beta, format: "json" } });
		expect(exported.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const sections = sectionsOf(exported.frames);
		const header = sections.find(section => section.tag === "ActiveSession");
		expect((header?.value as HeaderSection | undefined)?.value.id).toBe(beta);
	});

	test("a rename of the open session states its header without restating the transcript", async () => {
		await client.request(1, { OpenSession: { session: alpha } });

		const renamed = await client.request(2, { RenameSession: { session: alpha, title: "Renamed" } });
		expect(renamed.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const sections = sectionsOf(renamed.frames);
		const header = sections.find(section => section.tag === "ActiveSession");
		expect((header?.value as HeaderSection | undefined)?.value).toMatchObject({ id: alpha, title: "Renamed" });
		expect(sections.filter(section => section.tag === "Transcript")).toEqual([]);
	});

	test("no action sends a transcript in front of the header that names its session", async () => {
		// One argument set per tag. A new action tag fails this type check until
		// it is given one, which is the decision this suite asks for.
		const args: Record<HostActionTag, unknown> = {
			Attach: { Attach: { endpoint: null } },
			Detach: "Detach",
			RetryConnection: "RetryConnection",
			Shutdown: "Shutdown",
			ListSessions: "ListSessions",
			LoadTranscript: { LoadTranscript: { session: beta, before: null } },
			OpenSession: { OpenSession: { session: alpha } },
			CreateSession: { CreateSession: { title: "Swept" } },
			RenameSession: { RenameSession: { session: alpha, title: "Swept" } },
			DeleteSession: { DeleteSession: { session: "session-that-is-not-here" } },
			BranchSession: { BranchSession: { session: alpha, entry: null } },
			ExportSession: { ExportSession: { session: beta, format: "json" } },
			CompactSession: { CompactSession: { session: alpha } },
			HandoffSession: { HandoffSession: { session: alpha, target: "" } },
			SubmitPrompt: { SubmitPrompt: { session: alpha, text: "", attachments: [] } },
			Steer: { Steer: { session: alpha, text: "" } },
			FollowUp: { FollowUp: { session: alpha, text: "" } },
			AbortTurn: { AbortTurn: { session: alpha } },
			SetQueueMode: { SetQueueMode: { session: alpha, mode: "steer" } },
			SetSessionMode: { SetSessionMode: { session: alpha, mode: "none" } },
			CancelTool: { CancelTool: { session: alpha, call_id: "call-1" } },
			SetToolViewExpanded: { SetToolViewExpanded: { session: alpha, call_id: "call-1", expanded: true } },
			DequeueQueuedPrompt: { DequeueQueuedPrompt: { session: alpha } },
			RespondToInteraction: { RespondToInteraction: { session: alpha, interaction: "i-1", response: "yes" } },
			LoadFileTree: { LoadFileTree: { path: null, depth: 1 } },
			ReadFile: { ReadFile: { path: "missing.txt" } },
			SearchFiles: { SearchFiles: { query: "alpha" } },
			SearchContent: { SearchContent: { query: "alpha" } },
			OpenExternal: { OpenExternal: { target: "" } },
			RefreshChanges: "RefreshChanges",
			SelectChangeScope: { SelectChangeScope: { scope: "working_tree" } },
			CreateTerminal: "CreateTerminal",
			AttachTerminal: { AttachTerminal: { terminal: "t-1" } },
			WriteTerminal: { WriteTerminal: { terminal: "t-1", data: "" } },
			ResizeTerminal: { ResizeTerminal: { terminal: "t-1", cols: 80, rows: 24 } },
			RestartTerminal: { RestartTerminal: { terminal: "t-1" } },
			ClearTerminal: { ClearTerminal: { terminal: "t-1" } },
			CloseTerminal: { CloseTerminal: { terminal: "t-1" } },
			RefreshProcesses: "RefreshProcesses",
			ProcessLogs: { ProcessLogs: { process: "p-1" } },
			ProcessSend: { ProcessSend: { process: "p-1", data: "" } },
			ProcessSignal: { ProcessSignal: { process: "p-1", signal: "SIGTERM" } },
			ProcessStop: { ProcessStop: { process: "p-1" } },
			ProcessRestart: { ProcessRestart: { process: "p-1" } },
			ProcessStart: { ProcessStart: { application: "true", args: [] } },
			RefreshModels: "RefreshModels",
			SelectModel: { SelectModel: { session: alpha, provider: "openai", model: "gpt-4o-mini" } },
			SetThinkingLevel: { SetThinkingLevel: { session: alpha, level: "off" } },
			RefreshProviders: "RefreshProviders",
			StartProviderAuth: { StartProviderAuth: { provider: "openai", method: "api_key" } },
			SubmitAuthSecret: { SubmitAuthSecret: { provider: "openai", secret: "" } },
			OpenAuthUrl: { OpenAuthUrl: { provider: "openai" } },
			CancelAuthFlow: "CancelAuthFlow",
			RetryAuthFlow: "RetryAuthFlow",
			RefreshMcp: "RefreshMcp",
			SetMcpEnabled: { SetMcpEnabled: { server: "none", enabled: false } },
			ReviveAgent: { ReviveAgent: { agent: "a-1" } },
			SpawnTask: { SpawnTask: { prompt: "" } },
			CancelTask: { CancelTask: { task: "t-1" } },
			LoadSettings: "LoadSettings",
			SetSetting: { SetSetting: { key: "theme", value: "dark" } },
			ResetSetting: { ResetSetting: { key: "theme" } },
			LoadThemes: "LoadThemes",
			LoadKeybindings: "LoadKeybindings",
			SetKeybinding: { SetKeybinding: { action: "composer.send", keys: ["enter"] } },
			RefreshDiagnostics: "RefreshDiagnostics",
			RetryDiagnosticSource: { RetryDiagnosticSource: { source: "none" } },
			ClearOutput: { ClearOutput: { session: alpha } },
			GetUsage: "GetUsage",
			GetContextBreakdown: { GetContextBreakdown: { session: alpha } },
		};

		const swept = ALL_HOST_ACTIONS.filter(tag => tag !== ENDS_THE_CONNECTION && tag !== REATTACHES);
		const carried: HostActionTag[] = [];
		let id = 100;
		for (const tag of swept) {
			id += 1;
			const { frames } = await client.request(id, args[tag]);
			const sections = sectionsOf(frames);
			let header: HeaderSection | undefined;
			for (const section of sections) {
				if (section.tag === "ActiveSession") {
					header = section.value as HeaderSection;
					continue;
				}
				if (section.tag !== "Transcript") continue;
				if (!carried.includes(tag)) carried.push(tag);
				expect(header, `${tag} sent a transcript with no header naming its session`).toBeDefined();
			}
		}

		for (const tag of ALWAYS_CARRY_A_TRANSCRIPT) {
			expect(carried, `${tag} sent no transcript, so the sweep proved nothing about it`).toContain(tag);
		}
		expect(carried.filter(tag => !MAY_CARRY_A_TRANSCRIPT.includes(tag))).toEqual([]);
	}, 30000);
});
