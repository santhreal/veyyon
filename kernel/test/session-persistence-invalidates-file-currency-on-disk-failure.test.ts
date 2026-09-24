/**
 * WHY:
 * When an asynchronous disk error occurs during session append/write, #noteDiskFailure
 * latches #diskFailure and logs the error. Previously, it failed to invalidate #fileIsCurrent
 * or flag #rewriteRequired = true.
 * Consequently, subsequent calls like `ensureOnDisk()` saw `#fileIsCurrent && !#rewriteRequired`
 * as true and returned immediately without rewriting the diverged/truncated file to disk.
 * Now, any disk failure immediately marks `#fileIsCurrent = false` and `#rewriteRequired = true`,
 * ensuring `ensureOnDisk()` properly heals the transcript on disk once storage recovers.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@veyyon/kernel/session/session-storage";

class FlakyFileStorage extends FileSessionStorage {
	failure: string | undefined;

	openWriter(filePath: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const inner = super.openWriter(filePath, options);
		const owner = this;
		return {
			append(line: string): Promise<void> {
				if (owner.failure) {
					const p = Promise.reject(new Error(owner.failure));
					p.catch(() => {});
					return p;
				}
				return inner.append(line);
			},
			flush: () => inner.flush(),
			isOpen: () => inner.isOpen(),
			close: () => inner.close(),
			getError: () => inner.getError(),
		};
	}

	writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failure) return Promise.reject(new Error(this.failure));
		return super.writeTextAtomic(filePath, content, options);
	}

	writeTextSync(filePath: string, content: string): void {
		if (this.failure) throw new Error(this.failure);
		super.writeTextSync(filePath, content);
	}
}

describe("session persistence invalidates file currency on disk failure", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await fsp.rm(dir, { recursive: true, force: true });
			} catch {}
		}
		tempDirs.length = 0;
	});

	it("invalidates onDisk state and forces rewrite on ensureOnDisk after a disk failure is noted", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sess-disk-failure-"));
		tempDirs.push(tempDir);

		const storage = new FlakyFileStorage();
		const sm = SessionManager.create(tempDir, tempDir, storage);
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Hello" }],
			timestamp: 1,
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Hi there" }],
			timestamp: 2,
			api: "mock",
			provider: "mock",
			model: "mock",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		await sm.flush();

		const sessionFile = sm.getSessionFile();
		expect(sessionFile).toBeDefined();

		// Initially, the file is current on disk
		expect(sm.captureState().onDisk).toBe(true);

		// Now inject a disk fault during append
		storage.failure = "disk write error (simulated ENOSPC)";
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Message during failure" }],
			timestamp: 3,
		});
		await sm.flush().catch(() => undefined);

		// Because #noteDiskFailure was called, onDisk must be invalidated
		expect(sm.captureState().onDisk).toBe(false);

		// Now storage heals
		storage.failure = undefined;

		// ensureOnDisk must rewrite the file to disk with the missing message
		await sm.ensureOnDisk();

		// The file must now be current and contain all 3 messages
		expect(sm.captureState().onDisk).toBe(true);
		const content = await fsp.readFile(sessionFile!, "utf-8");
		expect(content).toContain("Message during failure");
	});
});
