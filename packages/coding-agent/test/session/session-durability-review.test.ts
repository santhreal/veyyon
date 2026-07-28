/**
 * Behavioral regressions for session durability across storage backends.
 *
 * These tests exercise the public manager/listing/loader contracts rather than
 * implementation text: failed transitions leave the old resumable state intact,
 * indexed keys need no filesystem mirror, and record-loss notices never echo
 * the dropped record's content.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@veyyon/coding-agent/session/indexed-session-storage";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { listAllSessions, listSessions, resolveResumableSession } from "@veyyon/coding-agent/session/session-listing";
import { parseSessionContent } from "@veyyon/coding-agent/session/session-loader";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@veyyon/coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@veyyon/coding-agent/session/session-title-slot";
import { getAgentDir } from "@veyyon/utils";

const ISO = "2026-07-28T12:00:00.000Z";

function header(id: string, cwd = "/project"): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: ISO, cwd };
}

function jsonl(records: readonly unknown[]): string {
	return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

class FailingAtomicMemoryStorage extends MemorySessionStorage {
	failAtomicWrites = false;

	override writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failAtomicWrites) return Promise.reject(new Error("injected atomic write failure"));
		return super.writeTextAtomic(filePath, content, options);
	}
}

interface BackendFile {
	content: string;
	mtimeMs: number;
}

class MapBackend implements SessionStorageBackend {
	readonly files = new Map<string, BackendFile>();
	failWrites = false;

	init(): Promise<void> {
		return Promise.resolve();
	}

	loadIndex(): Promise<SessionStorageIndexEntry[]> {
		return Promise.resolve(
			Array.from(this.files, ([filePath, file]) => ({
				path: filePath,
				size: Buffer.byteLength(file.content),
				mtimeMs: file.mtimeMs,
			})),
		);
	}

	readFull(filePath: string): Promise<string | null> {
		return Promise.resolve(this.files.get(filePath)?.content ?? null);
	}

	readSlices(filePath: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const file = this.files.get(filePath);
		if (!file) return Promise.resolve(["", ""]);
		const bytes = Buffer.from(file.content);
		return Promise.resolve([
			bytes.subarray(0, prefixBytes).toString("utf-8"),
			bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString("utf-8"),
		]);
	}

	writeFull(filePath: string, content: string, mtimeMs: number, _title?: SessionTitleUpdate): Promise<void> {
		if (this.failWrites) return Promise.reject(new Error("injected backend write failure"));
		this.files.set(filePath, { content, mtimeMs });
		return Promise.resolve();
	}

	append(filePath: string, line: string, mtimeMs: number): Promise<void> {
		const prior = this.files.get(filePath)?.content ?? "";
		this.files.set(filePath, { content: prior + line, mtimeMs });
		return Promise.resolve();
	}

	updateSessionTitle(_filePath: string, _title: SessionTitleUpdate, _mtimeMs: number): Promise<void> {
		return Promise.resolve();
	}

	truncate(filePath: string, mtimeMs: number): Promise<void> {
		this.files.set(filePath, { content: "", mtimeMs });
		return Promise.resolve();
	}

	remove(paths: string[]): Promise<void> {
		for (const filePath of paths) this.files.delete(filePath);
		return Promise.resolve();
	}

	move(source: string, target: string, mtimeMs: number): Promise<void> {
		const file = this.files.get(source);
		if (!file) return Promise.reject(new Error(`missing backend key: ${source}`));
		this.files.set(target, { content: file.content, mtimeMs });
		this.files.delete(source);
		return Promise.resolve();
	}
}

describe("session durability review regressions", () => {
	/** A malformed non-empty header must fail closed without initializing over recoverable bytes. */
	it("rejects a corrupt non-empty transcript without changing one byte", async () => {
		const storage = new MemorySessionStorage();
		const file = "/sessions/corrupt.jsonl";
		const corrupt = "{this is not a session header}\n";
		storage.writeTextSync(file, corrupt);

		await expect(SessionManager.open(file, undefined, storage, { initialCwd: "/project" })).rejects.toThrow(
			/corrupt session/,
		);
		expect(await storage.readText(file)).toBe(corrupt);
	});

	/** A failed persisted CWD rewrite must restore both runtime and header authority. */
	it("rolls cwd and header state back when the persisted header rewrite fails", async () => {
		const storage = new FailingAtomicMemoryStorage();
		const manager = SessionManager.create("/old", "/sessions/old", storage);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected persisted session file");
		const before = await storage.readText(file);
		storage.failAtomicWrites = true;

		await expect(manager.setCwd("/new", { validate: false })).rejects.toThrow("injected atomic write failure");
		expect(manager.getCwd()).toBe("/old");
		expect(manager.getHeader()?.cwd).toBe("/old");
		expect(await storage.readText(file)).toBe(before);
	});

	/** A final publish failure must return file-backed transcript and artifacts to their old paths. */
	it("rolls transcript and artifacts back when the final move rewrite fails", async () => {
		const storage = new FailingAtomicMemoryStorage();
		const manager = SessionManager.create("/old", "/sessions/old", storage);
		await manager.ensureOnDisk();
		const oldFile = manager.getSessionFile();
		if (!oldFile) throw new Error("expected persisted session file");
		const artifact = `${oldFile.slice(0, -6)}/tool.txt`;
		storage.writeTextSync(artifact, "artifact-body");
		const targetDir = "/sessions/new";
		const newFile = path.join(targetDir, path.basename(oldFile));
		storage.failAtomicWrites = true;

		await expect(manager.moveTo("/new", targetDir)).rejects.toThrow("injected atomic write failure");
		expect(manager.getCwd()).toBe("/old");
		expect(manager.getSessionFile()).toBe(oldFile);
		expect(storage.existsSync(oldFile)).toBeTrue();
		expect(storage.existsSync(artifact)).toBeTrue();
		expect(storage.existsSync(newFile)).toBeFalse();
		expect(storage.existsSync(`${newFile.slice(0, -6)}/tool.txt`)).toBeFalse();
	});

	/** Indexed rollback must restore backend keys after relocation succeeds but header publication fails. */
	it("rolls an indexed transcript and artifacts back after the moved header publish fails", async () => {
		const backend = new MapBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/old", "/virtual/rollback-old", storage);
		await manager.ensureOnDisk();
		const oldFile = manager.getSessionFile();
		if (!oldFile) throw new Error("expected indexed session file");
		const oldArtifact = `${oldFile.slice(0, -6)}/result.txt`;
		await storage.writeText(oldArtifact, "indexed artifact");
		const targetDir = "/virtual/rollback-new";
		const newFile = path.join(targetDir, path.basename(oldFile));
		backend.failWrites = true;

		await expect(manager.moveTo("/new", targetDir)).rejects.toThrow("injected backend write failure");

		expect(manager.getSessionFile()).toBe(oldFile);
		expect(manager.getCwd()).toBe("/old");
		expect(backend.files.has(oldFile)).toBeTrue();
		expect(backend.files.has(oldArtifact)).toBeTrue();
		expect(backend.files.has(newFile)).toBeFalse();
		expect(backend.files.has(`${newFile.slice(0, -6)}/result.txt`)).toBeFalse();
	});

	/** Backend-only sessions and artifacts must move and remain globally listable without local files. */
	it("moves and lists indexed sessions and artifacts without filesystem mirrors", async () => {
		const backend = new MapBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/old", "/virtual/old", storage);
		await manager.ensureOnDisk();
		const oldFile = manager.getSessionFile();
		if (!oldFile) throw new Error("expected indexed session file");
		const oldArtifact = `${oldFile.slice(0, -6)}/result.txt`;
		await storage.writeText(oldArtifact, "indexed artifact");
		const targetDir = "/virtual/new";
		const newFile = path.join(targetDir, path.basename(oldFile));

		await manager.moveTo("/new", targetDir);

		expect(fs.existsSync(newFile)).toBeFalse();
		expect(backend.files.has(oldFile)).toBeFalse();
		expect(backend.files.has(oldArtifact)).toBeFalse();
		expect(backend.files.has(newFile)).toBeTrue();
		expect(backend.files.has(`${newFile.slice(0, -6)}/result.txt`)).toBeTrue();
		expect((await listSessions(targetDir, storage)).map(session => session.path)).toEqual([newFile]);
	});

	/** Global resume must recover orphan backups in every indexed project bucket. */
	it("globally recovers and lists an indexed orphan backup", async () => {
		const backend = new MapBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const bucket = path.join(getAgentDir(), "sessions", "indexed-orphan-review");
		const primary = path.join(bucket, "orphan.jsonl");
		const backup = `${primary}.123.bak`;
		await storage.writeText(backup, jsonl([header("orphan", "/indexed/project")]));

		const sessions = await listAllSessions(storage);
		const resumed = await resolveResumableSession("orphan", "/unrelated/project", undefined, storage);

		expect(sessions.map(session => session.path)).toContain(primary);
		expect(storage.existsSync(primary)).toBeTrue();
		expect(storage.existsSync(backup)).toBeFalse();
		expect(resumed?.session.path).toBe(primary);
		expect(resumed?.scope).toBe("global");
	});

	/** Dropped malformed records must surface location and shape without echoing their content. */
	it("raises one content-free path, line, byte and problem notice for a dropped shape", () => {
		const notices = new OperatorNotices();
		const goodHeader = JSON.stringify(header("notice"));
		const secretContent = "DO-NOT-ECHO-THIS-CONTENT";
		const bad = JSON.stringify({
			type: "message",
			id: "bad",
			parentId: null,
			timestamp: ISO,
			message: secretContent,
		});
		const source = "/sessions/notice.jsonl";

		parseSessionContent(`${goodHeader}\n${bad}\n`, { source, operatorNotices: notices });

		const [notice] = notices.all();
		expect(notices.all()).toHaveLength(1);
		expect(notice?.text).toContain(source);
		expect(notice?.text).toContain("line 2");
		expect(notice?.text).toContain(`byte ${Buffer.byteLength(goodHeader) + 2}`);
		expect(notice?.text).toContain("a message entry has no `message` object");
		expect(notice?.text).not.toContain(secretContent);
	});

	/** Hosts that attach notices after manager construction must receive later load warnings. */
	it("routes later manager loads through an attached operator notice channel", async () => {
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create("/launch", "/sessions", storage);
		const notices = new OperatorNotices();
		manager.setOperatorNotices(notices);
		const file = "/sessions/supplied-manager.jsonl";
		storage.writeTextSync(
			file,
			jsonl([
				header("supplied", "/missing-recorded-project"),
				{ type: "message", id: "bad", parentId: null, timestamp: ISO, message: "not-an-object" },
			]),
		);

		await manager.setSessionFile(file);

		expect(notices.all()).toHaveLength(1);
		expect(notices.all()[0]?.text).toContain(file);
		expect(notices.all()[0]?.text).toContain("a message entry has no `message` object");
	});
});
