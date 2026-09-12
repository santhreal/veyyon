/**
 * WHY: Session storage writers across backends (FileSessionStorage, MemorySessionStorage,
 * and IndexedSessionStorage / SqlSessionStorage) must conform to a uniform public lifecycle
 * and error contract: isOpen reflecting active vs closed state, append throwing "Writer closed"
 * once closed, idempotent close, and asynchronous/synchronous error notification via onError
 * and error latching across subsequent append/flush calls.
 *
 * This suite exercises actual public behavior across every storage dialect without mocking
 * internal base classes.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriter,
} from "@veyyon/kernel/session/session-storage";
import { SqlSessionStorage } from "@veyyon/kernel/session/sql-session-storage";
import { SQL } from "bun";

describe("session storage writers conform to lifecycle and error contracts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("MemorySessionStorage writer", () => {
		it("manages healthy open/append/flush/close lifecycle", async () => {
			const storage = new MemorySessionStorage();
			const filePath = "/test/session.jsonl";
			const writer = storage.openWriter(filePath);

			expect(writer.isOpen()).toBe(true);
			expect(writer.getError()).toBeUndefined();

			await writer.append('{"type":"session","id":"m1"}\n');
			await writer.flush();
			expect(storage.readTextSync(filePath)).toBe('{"type":"session","id":"m1"}\n');

			await writer.close();
			expect(writer.isOpen()).toBe(false);

			// Idempotent close
			await writer.close();
			expect(writer.isOpen()).toBe(false);

			await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("Writer closed");
		});

		it("creates empty file on truncate flag w", async () => {
			const storage = new MemorySessionStorage();
			const filePath = "/test/trunc.jsonl";
			storage.writeTextSync(filePath, "existing\n");

			const writer = storage.openWriter(filePath, { flags: "w" });
			expect(storage.readTextSync(filePath)).toBe("");

			await writer.append("new\n");
			await writer.close();
			expect(storage.readTextSync(filePath)).toBe("new\n");
		});
	});

	describe("FileSessionStorage writer", () => {
		it("manages healthy open/append/flush/close lifecycle on real filesystem", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-writer-test-"));
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = new FileSessionStorage();
				const filePath = path.join(tmpDir, "session.jsonl");
				writer = storage.openWriter(filePath);

				expect(writer.isOpen()).toBe(true);
				expect(writer.getError()).toBeUndefined();

				await writer.append('{"type":"session","id":"f1"}\n');
				await writer.flush();
				expect(fs.readFileSync(filePath, "utf8")).toBe('{"type":"session","id":"f1"}\n');

				await writer.close();
				expect(writer.isOpen()).toBe(false);

				// Idempotent close
				await writer.close();
				expect(writer.isOpen()).toBe(false);

				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("Writer closed");
			} finally {
				if (writer) {
					await writer.close();
				}
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});

		it("reports write error via onError and latches error on subsequent operations", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-writer-err-"));
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = new FileSessionStorage();
				const filePath = path.join(tmpDir, "err.jsonl");
				const seenErrors: Error[] = [];
				writer = storage.openWriter(filePath, {
					onError: err => seenErrors.push(err),
				});

				// Spy on fs.writeSync to simulate I/O failure
				const writeSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
					throw new Error("EIO: simulated disk write failure");
				});

				await expect(writer.append('{"type":"session"}\n')).rejects.toThrow("EIO: simulated disk write failure");

				expect(seenErrors).toHaveLength(1);
				expect(seenErrors[0]?.message).toBe("EIO: simulated disk write failure");
				expect(writer.getError()?.message).toBe("EIO: simulated disk write failure");

				// Subsequent append/flush must rethrow the latched error immediately
				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("EIO: simulated disk write failure");
				await expect(writer.flush()).rejects.toThrow("EIO: simulated disk write failure");

				writeSpy.mockRestore();
				await writer.close();
				expect(writer.isOpen()).toBe(false);
				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("Writer closed");
				await expect(writer.flush()).rejects.toThrow("EIO: simulated disk write failure");
			} finally {
				if (writer) {
					await writer.close();
				}
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});

		it("preserves first-error latching even when onError callback throws", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-writer-throw-"));
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = new FileSessionStorage();
				const filePath = path.join(tmpDir, "err_throw.jsonl");
				writer = storage.openWriter(filePath, {
					onError: () => {
						throw new Error("onError consumer exploded");
					},
				});

				const writeSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
					throw new Error("EIO: original write fault");
				});

				// append propagates the error from onError callback on initial failure
				await expect(writer.append('{"type":"session"}\n')).rejects.toThrow("onError consumer exploded");

				// First error from fs.writeSync must still be latched as the writer error
				expect(writer.getError()?.message).toBe("EIO: original write fault");

				// Subsequent calls rethrow the latched original write fault, distinguishing callback error from storage error
				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("EIO: original write fault");
				await expect(writer.flush()).rejects.toThrow("EIO: original write fault");

				writeSpy.mockRestore();
			} finally {
				if (writer) {
					await writer.close();
				}
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("IndexedSessionStorage / SqlSessionStorage writer", () => {
		it("manages healthy open/append/flush/close lifecycle", async () => {
			const client = new SQL("sqlite::memory:");
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = await SqlSessionStorage.create({ client });
				const filePath = "/sessions/p/sess_sql.jsonl";
				writer = storage.openWriter(filePath);

				expect(writer.isOpen()).toBe(true);
				expect(writer.getError()).toBeUndefined();

				await writer.append('{"type":"session","id":"s1"}\n');
				await writer.flush();
				expect(await storage.readText(filePath)).toBe('{"type":"session","id":"s1"}\n');

				await writer.close();
				expect(writer.isOpen()).toBe(false);

				// Idempotent close
				await writer.close();
				expect(writer.isOpen()).toBe(false);

				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("Writer closed");
			} finally {
				if (writer && writer.isOpen()) {
					await writer.close().catch(() => {});
				}
				await client.end();
			}
		});

		it("reports backend write error via onError, latches error, and rejects close on pending write failure", async () => {
			const client = new SQL("sqlite::memory:");
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = await SqlSessionStorage.create({ client });
				const filePath = "/sessions/p/fail_sql.jsonl";
				const seenErrors: Error[] = [];
				writer = storage.openWriter(filePath, {
					onError: err => seenErrors.push(err),
				});

				// Force error by dropping the table so background queueAppend rejects
				await client.unsafe("DROP TABLE veyyon_session_files");

				await expect(writer.append("doomed\n")).rejects.toThrow(/no such table/i);

				expect(seenErrors).toHaveLength(1);
				expect(seenErrors[0]?.message).toMatch(/no such table/i);
				expect(writer.getError()?.message).toMatch(/no such table/i);

				// Subsequent append/flush rethrows latched error
				await expect(writer.append("more\n")).rejects.toThrow(/no such table/i);
				await expect(writer.flush()).rejects.toThrow(/no such table/i);

				// IndexedSessionStorageWriter.close() awaits flush() and rejects with the latched write error
				await expect(writer.close()).rejects.toThrow(/no such table/i);
				expect(writer.isOpen()).toBe(false);

				// Subsequent close is idempotent and resolves
				await writer.close();
				expect(writer.isOpen()).toBe(false);
			} finally {
				if (writer && writer.isOpen()) {
					await writer.close().catch(() => {});
				}
				await client.end();
			}
		});
	});
});
