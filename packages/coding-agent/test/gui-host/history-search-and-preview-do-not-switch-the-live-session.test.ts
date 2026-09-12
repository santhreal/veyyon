/**
 * WHY: persisted content search must read beyond the listing prefix, and preview
 * must not activate, rewrite or take a writer lock on a selected session.
 * Exercises real storage and the production framed host dispatcher. Does not
 * cover native pixels or real provider availability.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { getProjectDir, setProjectDir } from "@veyyon/utils";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { SessionHeaderView, SessionSummary, TranscriptEntry, Versioned } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

let root: string;
let server: GuiHostServer;
let client: TestSocketClient;
let alpha: SessionManager;
let beta: SessionManager;
let betaPath: string;
let previousProcessCwd: string;
let previousProjectDir: string;

async function seed(cwd: string, title: string, texts: string[]): Promise<SessionManager> {
	await fs.mkdir(cwd, { recursive: true });
	const storage = new FileSessionStorage();
	const dir = computeDefaultSessionDir(cwd, storage, path.join(root, "sessions"));
	const sm = SessionManager.create(cwd, dir, storage);
	await sm.setSessionName(title, "user");
	for (const text of texts)
		sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 });
	sm.appendModeChange("plan");
	await sm.ensureOnDisk();
	await sm.flush();
	return sm;
}

beforeEach(async () => {
	previousProcessCwd = process.cwd();
	previousProjectDir = getProjectDir();
	const scratch = path.resolve(".internal", "history-tests");
	await fs.mkdir(scratch, { recursive: true });
	root = await fs.mkdtemp(path.join(scratch, "run-"));
	alpha = await seed(path.join(root, "alpha"), "Active work", ["alpha prompt"]);
	beta = await seed(path.join(root, "beta"), "Other work", ["padding ".repeat(2048), "buried Needle Ω"]);
	betaPath = beta.getSessionFile()!;
	await fs.writeFile(path.join(root, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n");
	const authStorage = await isolatedAuthStorage(root);
	authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
	server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: alpha.getCwd(), agentDir: root, authStorage });
	client = await TestSocketClient.connect(server.endpoint);
	await client.nextFrame();
	await client.nextFrame();
	await client.request(1, { OpenSession: { session: alpha.getSessionId() } });
});

afterEach(async () => {
	try {
		client?.destroy();
		await server?.close();
	} finally {
		vi.restoreAllMocks();
		setProjectDir(previousProjectDir);
		process.chdir(previousProcessCwd);
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

test("browse spans repositories, content search finds late Unicode text, preview stays read-only and resume restores state", async () => {
	const bytes = await fs.readFile(betaPath);
	const before = await fs.stat(betaPath);
	const browse = await client.request(2, { SearchSessions: { query: "" } });
	const listed = snapshotSections<{ query: string; sessions: SessionSummary[] }>(browse.frames, "SessionSearch")[0];
	expect(new Set(listed.sessions.map(session => session.cwd))).toEqual(new Set([alpha.getCwd(), beta.getCwd()]));
	for (const [id, query] of ["NEEDLE Ω", "no such phrase"].entries()) {
		const result = await client.request(3 + id, { SearchSessions: { query } });
		const found = snapshotSections<{ query: string; sessions: SessionSummary[] }>(result.frames, "SessionSearch")[0];
		expect(found.query).toBe(query);
		expect(found.sessions.map(session => session.id)).toEqual(id === 0 ? [beta.getSessionId()] : []);
	}
	const preview = await client.request(5, { PreviewSessionTranscript: { session: betaPath } });
	expect(preview.outcome).toEqual({ RequestSucceeded: { request: 5 } });
	expect(snapshotSections(preview.frames, "ActiveSession")).toEqual([]);
	expect(snapshotSections(preview.frames, "Transcript")).toEqual([]);
	const shown = snapshotSections<{ session: string; transcript: Versioned<TranscriptEntry[]> }>(
		preview.frames,
		"SessionTranscript",
	)[0];
	expect(shown.session).toBe(betaPath);
	expect(
		shown.transcript.value.some(entry =>
			entry.content.some(block => "Text" in block && block.Text.text === "buried Needle Ω"),
		),
	).toBe(true);
	expect(await fs.readFile(betaPath)).toEqual(bytes);
	expect((await fs.stat(betaPath)).mtimeMs).toBe(before.mtimeMs);
	// An inactive rename emits no ActiveSession header: this observes host state,
	// not only the absence of an unsolicited switch frame during preview.
	const renamed = await client.request(6, { RenameSession: { session: alpha.getSessionId(), title: "Still active" } });
	expect(snapshotSections<Versioned<SessionHeaderView>>(renamed.frames, "ActiveSession")[0].value.id).toBe(
		alpha.getSessionId(),
	);
	const resumed = await client.request(7, { OpenSession: { session: betaPath } });
	const header = snapshotSections<Versioned<SessionHeaderView>>(resumed.frames, "ActiveSession")[0].value;
	expect(header.id).toBe(beta.getSessionId());
	expect(header.mode).toBe("plan");
	expect(snapshotSections<Versioned<TranscriptEntry[]>>(resumed.frames, "Transcript")[0].value).toEqual(
		shown.transcript.value.map(entry => ({ ...entry, revision: expect.any(Number) })),
	);
}, 30000);

test("missing, corrupt and malformed history requests fail rather than replacing the live session", async () => {
	const missing = await client.request(2, { PreviewSessionTranscript: { session: "missing-session" } });
	expect(missing.outcome.RequestFailed?.error.code).toBe("SESSION_NOT_FOUND");
	const invalid = await client.request(3, { SearchSessions: {} });
	expect(invalid.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
	await fs.writeFile(betaPath, "not a session\n");
	const corrupt = await client.request(4, { PreviewSessionTranscript: { session: betaPath } });
	expect(corrupt.outcome.RequestFailed?.error.code).toBe("PREVIEW_SESSION_FAILED");
	const search = await client.request(5, { SearchSessions: { query: "" } });
	expect(search.outcome.RequestFailed?.error.code).toBe("SEARCH_SESSIONS_FAILED");
	expect(snapshotSections(search.frames, "SessionSearch")).toEqual([]);
	const renamed = await client.request(6, { RenameSession: { session: alpha.getSessionId(), title: "Not switched" } });
	expect(snapshotSections<Versioned<SessionHeaderView>>(renamed.frames, "ActiveSession")[0].value.id).toBe(
		alpha.getSessionId(),
	);
}, 30000);

test("an inaccessible archive is reported rather than displayed as an empty search", async () => {
	await fs.rename(path.join(root, "sessions"), path.join(root, "saved-sessions"));
	await fs.writeFile(path.join(root, "sessions"), "not a directory");
	const result = await client.request(2, { SearchSessions: { query: "" } });
	expect(result.outcome.RequestFailed?.error.code).toBe("SEARCH_SESSIONS_FAILED");
	expect(snapshotSections(result.frames, "SessionSearch")).toEqual([]);
}, 30000);

test("resuming another repository rescopes an existing agent and every workspace request", async () => {
	const contexts: string[] = [];
	vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
		contexts.push(JSON.stringify(context.messages));
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Finished." }],
			api: "openai-chat",
			provider: "openai",
			model: "gpt-4o-mini",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({
				type: "text_start",
				contentIndex: 0,
				partial: { ...message, content: [{ type: "text", text: "" }] },
			});
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Finished.", partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: "Finished.", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	});
	await fs.writeFile(path.join(alpha.getCwd(), "marker.txt"), "ALPHA_WORKSPACE_MARKER");
	await fs.writeFile(path.join(beta.getCwd(), "marker.txt"), "BETA_WORKSPACE_MARKER");
	await client.request(10, { LoadFileTree: { path: null } });
	const initialized = await client.request(11, {
		SubmitPrompt: { session: alpha.getSessionId(), text: "Initialize this conversation", attachments: [] },
	});
	expect(initialized.outcome).toEqual({ RequestSucceeded: { request: 11 } });
	if (!initialized.frames.some(frame => frame.StreamingChanged === null)) {
		while (((await client.nextFrame()) as { StreamingChanged?: unknown }).StreamingChanged !== null) {}
	}
	expect(contexts.some(context => context.includes("Initialize this conversation"))).toBe(true);
	const resumed = await client.request(12, { OpenSession: { session: betaPath } });
	expect(resumed.outcome).toEqual({ RequestSucceeded: { request: 12 } });
	expect(snapshotSections<{ root: string }>(resumed.frames, "FileTree").at(-1)?.root).toBe(beta.getCwd());
	const inspected = await client.request(13, { ReadFile: { path: "marker.txt" } });
	expect(snapshotSections<{ content: string }>(inspected.frames, "FileContent")[0].content).toBe(
		"BETA_WORKSPACE_MARKER",
	);
	const listed = await client.request(14, "ListSessions");
	expect(
		snapshotSections<[{ value: SessionSummary[] }, unknown[]]>(listed.frames, "Sessions")[0][0].value.map(
			session => session.id,
		),
	).toContain(beta.getSessionId());
	contexts.length = 0;
	const prompted = await client.request(15, {
		SubmitPrompt: { session: beta.getSessionId(), text: "Inspect @marker.txt", attachments: [] },
	});
	expect(prompted.outcome).toEqual({ RequestSucceeded: { request: 15 } });
	if (!prompted.frames.some(frame => frame.StreamingChanged === null)) {
		while (((await client.nextFrame()) as { StreamingChanged?: unknown }).StreamingChanged !== null) {}
	}
	expect(contexts.some(context => context.includes("BETA_WORKSPACE_MARKER"))).toBe(true);
	expect(contexts.some(context => context.includes("ALPHA_WORKSPACE_MARKER"))).toBe(false);
	const returned = await client.request(16, { OpenSession: { session: alpha.getSessionId() } });
	expect(returned.outcome).toEqual({ RequestSucceeded: { request: 16 } });
	const original = await client.request(17, { ReadFile: { path: "marker.txt" } });
	expect(snapshotSections<{ content: string }>(original.frames, "FileContent")[0].content).toBe(
		"ALPHA_WORKSPACE_MARKER",
	);
}, 30000);
