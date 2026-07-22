import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { listSessions } from "@veyyon/coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@veyyon/coding-agent/session/session-loader";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";

class CountingMemorySessionStorage extends MemorySessionStorage {
	writeTextSyncCalls = 0;

	writeTextSync(filePath: string, content: string): void {
		this.writeTextSyncCalls++;
		super.writeTextSync(filePath, content);
	}
}

function makeAssistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

/**
 * Regression suite for DATALOSS-1: compaction summaries must survive every
 * compaction, on disk and across resume.
 *
 * Two elision mechanisms used to destroy them. (1) `SessionManager.appendCompaction`
 * called `#elideSupersededCompactionsOnBranch`, which on EVERY new compaction
 * overwrote all earlier active-branch summaries with a placeholder and nulled their
 * preserveData, then force-rewrote the file. (2) `loadEntriesFromFile` re-applied the
 * same elision on load. Together they meant a session that compacted N times kept
 * only the newest summary on disk — verified on a real 25-compaction session, 24 of
 * 25 summaries were the placeholder. That is the "sessions arent persisted after
 * 100s of compactions" data loss.
 *
 * The contract these tests lock in: every compaction summary and its preserveData is
 * retained verbatim in memory and on disk, on the active branch and across branches,
 * through a resume rewrite — WHILE `buildSessionContext` (non-transcript) still emits
 * only the latest compaction summary to the LLM, so keeping the record costs no
 * context tokens. Assertions compare exact summary strings, never shapes.
 */
describe("large session memory guards", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	it("does not rewrite an already-current session during sync flush", () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		storage.writeTextSyncCalls = 0;
		session.flushSync();

		expect(storage.writeTextSyncCalls).toBe(0);
	});

	it("preserves every superseded compaction summary on disk after a newer compaction", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		const firstSummary = `first-${"x".repeat(4096)}`;
		const firstPreserve = { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } };
		const secondSummary = `second-${"y".repeat(4096)}`;
		session.appendCompaction(firstSummary, undefined, firstKeptEntryId, 1000, undefined, undefined, firstPreserve);
		session.appendCompaction(secondSummary, undefined, firstKeptEntryId, 1000);
		await session.flush();

		// Both summaries and the superseded compaction's preserveData survive verbatim
		// in memory and on disk. Studying a session must see every summary it ever wrote.
		const compactions = session.getEntries().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.summary).toBe(firstSummary);
		expect(compactions[0]?.preserveData).toEqual(firstPreserve);
		expect(compactions[1]?.summary).toBe(secondSummary);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const persisted = await storage.readText(sessionFile);
		expect(persisted).toContain(firstSummary);
		expect(persisted).toContain(secondSummary);

		// But only the latest summary reaches the LLM context; superseded summaries stay out.
		const context = JSON.stringify(session.buildSessionContext().messages);
		expect(context).toContain(secondSummary);
		expect(context).not.toContain(firstSummary);
	});

	it("loads large session files preserving every compaction summary", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-large-session-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "large.jsonl");
		const oldSummary = `old-${"x".repeat(5 * 1024 * 1024)}`;
		const latestSummary = `latest-${"y".repeat(5 * 1024 * 1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: oldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "c1",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: makeAssistantMessage("hello"),
			},
			{
				type: "compaction",
				id: "c2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: latestSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		// This file is >8MiB, so it takes the streaming loader path. Every summary and
		// every preserveData field must survive the load unchanged.
		const entries = await loadEntriesFromFile(sessionFile);
		const compactions = entries.filter(entry => entry.type === "compaction");

		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.summary).toBe(oldSummary);
		expect(compactions[0]?.preserveData).toEqual({ stale: true });
		expect(compactions[1]?.summary).toBe(latestSummary);
	});

	it("preserves sibling-branch compactions when a newer compaction lands on another branch", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const rootId = session.appendMessage({ role: "user", content: "shared root", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("root reply"));

		const branchACompactionSummary = `branch-a-${"x".repeat(1024)}`;
		const branchAPreserve = { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } };
		session.appendCompaction(
			branchACompactionSummary,
			undefined,
			rootId,
			1000,
			undefined,
			undefined,
			branchAPreserve,
		);
		const branchACompactionId = session.getLeafId();
		if (!branchACompactionId) throw new Error("Expected branch A compaction id");

		session.branch(rootId);
		session.appendMessage(makeAssistantMessage("branch B reply"));
		const branchBCompactionSummary = `branch-b-${"y".repeat(1024)}`;
		session.appendCompaction(branchBCompactionSummary, undefined, rootId, 1000);

		const branchACompaction = session.getEntry(branchACompactionId);
		if (branchACompaction?.type !== "compaction") throw new Error("Expected sibling compaction entry");
		expect(branchACompaction.summary).toBe(branchACompactionSummary);
		expect(branchACompaction.preserveData).toEqual(branchAPreserve);

		const branchBCompactions = session
			.getEntries()
			.filter(entry => entry.type === "compaction" && entry.summary === branchBCompactionSummary);
		expect(branchBCompactions).toHaveLength(1);
	});

	it("preserves every compaction summary across branches on load", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-branch-load-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "branched.jsonl");
		const branchASummary = `branch-a-${"x".repeat(1024)}`;
		const branchBOldSummary = `branch-b-old-${"y".repeat(1024)}`;
		const branchBNewSummary = `branch-b-new-${"z".repeat(1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "shared", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "ca",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: branchASummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } },
			},
			{
				type: "compaction",
				id: "cb1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:03.000Z",
				summary: branchBOldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "cb1",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: makeAssistantMessage("branch b reply"),
			},
			{
				type: "compaction",
				id: "cb2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:05.000Z",
				summary: branchBNewSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile);
		const byId = new Map(entries.map(entry => [(entry as { id?: string }).id, entry] as const));
		const branchA = byId.get("ca");
		const branchBOld = byId.get("cb1");
		const branchBNew = byId.get("cb2");
		if (branchA?.type !== "compaction" || branchBOld?.type !== "compaction" || branchBNew?.type !== "compaction") {
			throw new Error("Expected compaction entries");
		}

		// Nothing is elided on load: the sibling-branch summary, the superseded
		// active-branch summary, and the latest summary all survive verbatim.
		expect(branchA.summary).toBe(branchASummary);
		expect(branchA.preserveData).toBeDefined();
		expect(branchBOld.summary).toBe(branchBOldSummary);
		expect(branchBOld.preserveData).toEqual({ stale: true });
		expect(branchBNew.summary).toBe(branchBNewSummary);
	});

	it("keeps every summary byte-for-byte across many compactions and a resume rewrite", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-many-compactions-"));
		tempDirs.push(tempDir);
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create(tempDir, `${tempDir}/sessions`, storage);
		const keptId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		// Simulate a long-lived session that compacts many times over.
		const summaries: string[] = [];
		for (let i = 0; i < 25; i++) {
			const summary = `compaction-${i}-${"z".repeat(256)}`;
			summaries.push(summary);
			session.appendCompaction(summary, `short-${i}`, keptId, 1000 + i);
		}
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// Every summary must be present in memory, on disk, and after a fresh load
		// that rewrites the file (the resume path). Not one of them may be elided.
		for (const summary of summaries) {
			expect(session.getEntries().some(e => e.type === "compaction" && e.summary === summary)).toBe(true);
		}
		const persisted = await storage.readText(sessionFile);
		for (const summary of summaries) expect(persisted).toContain(summary);

		const reloaded = await loadEntriesFromFile(sessionFile, storage);
		const reloadedSummaries = reloaded
			.filter(e => e.type === "compaction")
			.map(e => (e as { summary: string }).summary);
		expect(reloadedSummaries).toEqual(summaries);

		// The LLM context still carries only the newest summary, not the 24 older ones.
		const context = JSON.stringify(session.buildSessionContext().messages);
		expect(context).toContain(summaries[summaries.length - 1]);
		expect(context).not.toContain(summaries[0]);
	});

	it("keeps all 200 summaries byte-for-byte across a 100s-of-compactions lifetime with interleaved turns", async () => {
		// WHY: the user reported the loss "after 100s of compactions". This drives that
		// exact scale — 200 compactions interleaved with real user/assistant turns — and
		// asserts every summary survives in memory, on disk, and through a resume-rewrite
		// load, in order. Each summary is also unique, so a single elided or duplicated
		// entry fails. This is the headline regression at the reported magnitude.
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-200-compactions-"));
		tempDirs.push(tempDir);
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create(tempDir, `${tempDir}/sessions`, storage);
		const keptId = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("ok"));

		const summaries: string[] = [];
		for (let i = 0; i < 200; i++) {
			// A real turn between compactions, like a genuine long-lived session.
			session.appendMessage({ role: "user", content: `turn ${i}`, timestamp: 10 + i });
			session.appendMessage(makeAssistantMessage(`reply ${i}`));
			const summary = `sum-${i}-${"q".repeat(256)}`;
			summaries.push(summary);
			session.appendCompaction(summary, `short-${i}`, keptId, 2000 + i);
		}
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// In memory: every summary present, exactly once each (no elision, no dup).
		const inMemory = session
			.getEntries()
			.filter(e => e.type === "compaction")
			.map(e => (e as { summary: string }).summary);
		expect(inMemory).toEqual(summaries);

		// On disk: every summary literally present.
		const persisted = await storage.readText(sessionFile);
		for (const summary of summaries) expect(persisted).toContain(summary);

		// Through a resume-rewrite load: order and content preserved end to end.
		const reloaded = await loadEntriesFromFile(sessionFile, storage);
		const reloadedSummaries = reloaded
			.filter(e => e.type === "compaction")
			.map(e => (e as { summary: string }).summary);
		expect(reloadedSummaries).toEqual(summaries);

		// Context still carries only the newest summary regardless of history depth.
		const context = JSON.stringify(session.buildSessionContext().messages);
		expect(context).toContain(summaries[199]);
		expect(context).not.toContain(summaries[0]);
		expect(context).not.toContain(summaries[100]);
	});

	it("resuming a compacted session and compacting again preserves every pre-resume summary", async () => {
		// WHY: the real-world trigger was resume-then-compact. A session compacts, the
		// process exits, the user resumes with `--resume`, and it compacts again. The old
		// `#elideSupersededCompactionsOnBranch` fired on that next compaction and wiped
		// the pre-resume summaries off disk. This test performs a true resume (a fresh
		// SessionManager over the same storage via setSessionFile) between two waves of
		// compactions and asserts the first wave survives the second wave's rewrite.
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-resume-compact-"));
		tempDirs.push(tempDir);
		const storage = new CountingMemorySessionStorage();

		// Wave 1: original process compacts 15 times, then "exits" (flush).
		const first = SessionManager.create(tempDir, `${tempDir}/sessions`, storage);
		const keptId = first.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		first.appendMessage(makeAssistantMessage("hi"));
		const wave1: string[] = [];
		for (let i = 0; i < 15; i++) {
			const summary = `wave1-${i}-${"a".repeat(300)}`;
			wave1.push(summary);
			first.appendCompaction(summary, `s1-${i}`, keptId, 1000 + i);
		}
		await first.flush();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// Resume: a brand-new SessionManager adopts the file (the --resume path).
		const resumed = SessionManager.create(tempDir, `${tempDir}/sessions`, storage);
		await resumed.setSessionFile(sessionFile);

		// All wave-1 summaries are present immediately after resume.
		const afterResume = resumed
			.getEntries()
			.filter(e => e.type === "compaction")
			.map(e => (e as { summary: string }).summary);
		expect(afterResume).toEqual(wave1);

		// Wave 2: the resumed process compacts 15 more times, then flushes (rewrites file).
		const resumedKeptId = resumed.getEntries()[1]?.id ?? keptId;
		const wave2: string[] = [];
		for (let i = 0; i < 15; i++) {
			const summary = `wave2-${i}-${"b".repeat(300)}`;
			wave2.push(summary);
			resumed.appendCompaction(summary, `s2-${i}`, resumedKeptId, 2000 + i);
		}
		await resumed.flush();

		// Both waves survive on disk after the wave-2 rewrite — the pre-resume history
		// is NOT elided by the post-resume compactions. That is the fix.
		const persisted = await storage.readText(sessionFile);
		for (const summary of [...wave1, ...wave2]) expect(persisted).toContain(summary);

		const finalReload = await loadEntriesFromFile(sessionFile, storage);
		const finalSummaries = finalReload
			.filter(e => e.type === "compaction")
			.map(e => (e as { summary: string }).summary);
		expect(finalSummaries).toEqual([...wave1, ...wave2]);
	});

	it("uses developer prefix text when a fork has no early user message", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/sessions/project";
		const sessionFile = `${sessionDir}/fork.jsonl`;
		const lines = [
			{ type: "session", version: 3, id: "fork", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" },
			{
				type: "message",
				id: "d1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "developer", content: "Plan fork context", timestamp: 1 },
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		storage.writeTextSync(sessionFile, lines.join(""));

		const sessions = await listSessions(sessionDir, storage);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.firstMessage).toBe("Plan fork context");
	});
});
