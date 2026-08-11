import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { AssistantMessage } from "@veyyon/ai";
import { isRecord, TempDir } from "@veyyon/utils";
import { type OperatorNotice, OperatorNotices } from "../../src/session/operator-notices";
import { SessionManager } from "../../src/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "../../src/session/session-storage";

/**
 * WHY THIS SUITE EXISTS.
 *
 * A write to the transcript can fail while the conversation carries on: a full
 * disk, a network project that drops for a second, a session directory whose
 * permissions change under a running window. The manager latched that fault in
 * `#diskFailure`, and every later persist refused on the strength of the latch.
 * Three things followed, all of them observed on real files before this suite
 * existed:
 *
 *  1. THE TRANSCRIPT ENDED AT THE FAULT AND NEVER RESUMED. The entries after it
 *     reached memory and nothing ever tried the file again, so a disk that was
 *     healthy two seconds later still held a conversation that stopped mid-way.
 *     The turns were not damaged, they were simply never written.
 *  2. THE STALE ERROR WAS THROWN AT THE WRONG CALLER. The append that failed
 *     threw nothing (the writer rejects asynchronously), and the NEXT append,
 *     with a perfectly good disk underneath it, threw the earlier ENOSPC.
 *  3. NOBODY WAS TOLD. `#noteDiskFailure` wrote one `logger.error`, and the
 *     default transport set is file-only with no console transport, which a TUI
 *     could not use anyway. The operator watched a conversation that was not
 *     being saved and had no way to know.
 *
 * THE CLASS THIS CLOSES: a persistence fault is a moment, not a property of the
 * session. Every path that persists gives a latched fault one attempt to heal
 * (`#retryPersistenceAfterFailure`) and one attempt is enough, because a
 * full-file publish writes every entry the manager holds. The fault is reported
 * to the operator once per episode, where an episode ends at the next successful
 * publish, so a broken disk does not put a notice on screen per entry and a
 * second, different fault is not swallowed by the first one's flag.
 *
 * The rows drive a real `FileSessionStorage` on a real temp directory, with the
 * fault injected at the storage boundary (writer append, atomic publish and
 * synchronous publish), which is where a full disk or a denied directory
 * actually surfaces.
 *
 * WHAT THIS DOES NOT CATCH:
 * - A fault the storage layer reports as success. Nothing above the backend can
 *   detect that, and `session-storage-close-errors.test.ts` owns the writer's
 *   own error reporting.
 * - A backoff policy. There is none by design: the retry costs one serialization
 *   of the transcript per entry while the disk is broken, and entries arrive at
 *   the pace of a conversation. A row asserting a delay would be asserting a
 *   number nobody chose.
 * - Two windows on one transcript. That is a different class and lives in
 *   `two-managers-on-one-transcript.test.ts`; a fault here never republishes
 *   somebody else's file, it republishes this manager's own entries.
 *
 * MEASURED (mutation matrix, each mutant applied alone to `session-manager.ts`
 * and reverted with a checksum check, driver `/tmp/mutate-fault-recovery.py`):
 * - M17 `#retryPersistenceAfterFailure` never retries: 9 of the 11 rows red, which
 *   is the shape of a class rather than an incident.
 * - M18 the retry clears `#diskFailureLogged` along with the latch: the notice row
 *   red with one notice per refused entry. Two things make that row able to see it:
 *   the entries come AFTER the fault has been observed, so each one really does
 *   retry (a burst appended before the writer's rejection lands takes the hot path
 *   and never reaches the retry at all), and the injected fault numbers its
 *   attempts, so `OperatorNotices` collapsing identical text cannot stand in for
 *   the latch.
 * - M19a the synchronous publish does not clear the reported fault: the
 *   recovery-through-an-append row red. M19b the same for the atomic publish: the
 *   recovery-through-a-flush row red. One row covering both paths was green under
 *   either mutant alone, which is why there are two.
 * - M20 `close()` drops its recovery publish: the close row red.
 * - M21 `flushSync()` drops its retry: the exit-flush row red.
 * - M22 the operator notice is raised on another source: the notice row red.
 * - M23 the append path drops its retry: 5 rows red.
 * - M24 `flush()` drops its retry: the recovery-through-a-flush row red.
 */

/** Fails every write while `failure` names an error, so a fault can start and stop. */
class FlakyFileStorage extends FileSessionStorage {
	failure: string | undefined;
	/** Distinct per fault, so `OperatorNotices`'s own collapsing cannot stand in for the latch. */
	#attempt = 0;

	#fault(): Error {
		this.#attempt += 1;
		return Object.assign(new Error(`${this.failure} (attempt ${this.#attempt})`), { code: "ENOSPC" });
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const inner = super.openWriter(path, options);
		const owner = this;
		return {
			append(line: string): Promise<void> {
				if (owner.failure) return Promise.reject(owner.#fault());
				return inner.append(line);
			},
			flush: () => inner.flush(),
			isOpen: () => inner.isOpen(),
			close: () => inner.close(),
			getError: () => inner.getError(),
		};
	}

	writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failure) return Promise.reject(this.#fault());
		return super.writeTextAtomic(path, content, options);
	}

	writeTextSync(path: string, content: string): void {
		if (this.failure) throw this.#fault();
		super.writeTextSync(path, content);
	}
}

interface Fixture {
	manager: SessionManager;
	storage: FlakyFileStorage;
	notices: OperatorNotice[];
	file: string;
	temp: TempDir;
}

const open: Fixture[] = [];

function assistantMessage(text: string, at: number): AssistantMessage {
	return {
		role: "assistant",
		// Blocks, not a bare string: `checkSessionEntryShape` drops an assistant message
		// whose `content` is not an array, so a string here would make every reload row
		// pass or fail for a reason that has nothing to do with a disk fault.
		content: [{ type: "text", text }],
		timestamp: at,
		stopReason: "stop",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/**
 * The text of a message, whether it was stored as a string or as content blocks.
 *
 * `unknown` rather than a `content` shape, because the stored union includes members
 * that carry no `content` at all (a bash execution record), and a row asserting on
 * message text must not have to know which members those are.
 */
function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map(block => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("");
}

/** A persisted session with one turn already on disk, and the fault channel attached. */
async function fixture(): Promise<Fixture> {
	const temp = TempDir.createSync("@pi-session-fault-");
	const storage = new FlakyFileStorage();
	const manager = SessionManager.create(temp.path(), temp.path(), storage);
	const notices: OperatorNotice[] = [];
	manager.setOperatorNotices(new OperatorNotices(notice => notices.push(notice)));
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	manager.appendMessage(assistantMessage("answer", 2));
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("session file was never created");
	const entry: Fixture = { manager, storage, notices, file, temp };
	open.push(entry);
	return entry;
}

afterEach(async () => {
	for (const entry of open.splice(0)) {
		entry.storage.failure = undefined;
		await entry.manager.close().catch(() => undefined);
		await entry.temp.remove();
	}
});

describe("a persistence fault does not end the transcript", () => {
	it("writes the refused entries as soon as the next entry finds a healthy disk", async () => {
		const { manager, storage, file } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "during-the-fault", timestamp: 10 });
		manager.appendMessage(assistantMessage("also-during", 11));
		await manager.flush().catch(() => undefined);
		expect(await fs.readFile(file, "utf8")).not.toContain("during-the-fault");

		storage.failure = undefined;
		manager.appendMessage({ role: "user", content: "after-the-fault", timestamp: 12 });
		await manager.flush();

		// Every turn, in order, exactly once: the recovery republishes the whole
		// transcript rather than appending the newest line to a file with a hole in it.
		const raw = await fs.readFile(file, "utf8");
		for (const text of ["first", "answer", "during-the-fault", "also-during", "after-the-fault"]) {
			expect(raw.split(`"${text}"`).length - 1).toBe(1);
		}
	});

	it("does not throw the fault at the caller of a later, healthy append", async () => {
		const { manager, storage } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "during", timestamp: 10 });
		await manager.flush().catch(() => undefined);
		storage.failure = undefined;

		// The append that failed threw nothing (the writer rejects asynchronously), so
		// this one has no business inheriting its error.
		expect(() => manager.appendMessage({ role: "user", content: "after", timestamp: 11 })).not.toThrow();
		await manager.flush();
	});

	it("tells the operator once for the whole fault, not once per refused entry", async () => {
		const { manager, storage, notices, file } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "refused-0", timestamp: 20 });
		// The writer rejects on a later tick, so this is what makes the fault reach the
		// manager and latch. Everything appended after it retries the file and fails
		// again, which is the state the operator must not be told about five times.
		await manager.flush().catch(() => undefined);
		expect(notices).toHaveLength(1);

		for (let i = 1; i < 5; i++) manager.appendMessage({ role: "user", content: `refused-${i}`, timestamp: 20 + i });
		await manager.flush().catch(() => undefined);

		// Each of those four attempts raised a DIFFERENT error message (the injected
		// fault counts its attempts), so `OperatorNotices`'s own collapsing of identical
		// text cannot be what keeps this at one.
		expect(notices).toHaveLength(1);
		const notice = notices[0];
		// An "error" rather than a warning: the conversation is not being saved, which
		// is something not working rather than something to keep an eye on.
		expect(notice?.severity).toBe("error");
		expect(notice?.source).toBe("session");
		// The operator needs the file (which conversation), the errno (what to fix) and
		// what happens to the turns they can still see on screen.
		expect(notice?.text).toContain(file);
		expect(notice?.text).toContain("ENOSPC");
		expect(notice?.text).toContain("still complete in this window");
	});

	// Two rows, one per publish path, because there are two places a successful publish
	// can end the fault episode and each has to end it. A single row that both appends
	// and flushes is green with either one of them broken.
	it("speaks again for a second fault after a recovery through an append", async () => {
		const { manager, storage, notices } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "first-fault", timestamp: 30 });
		await manager.flush().catch(() => undefined);
		expect(notices).toHaveLength(1);

		// No flush: the append itself is the publish that heals the file, through the
		// synchronous rewrite the retry routes it to.
		storage.failure = undefined;
		manager.appendMessage({ role: "user", content: "healthy", timestamp: 31 });

		storage.failure = "EACCES: permission denied, write";
		manager.appendMessage({ role: "user", content: "second-fault", timestamp: 32 });
		// The writer rejects asynchronously, so the fault only reaches the manager on a
		// later tick. The flush is what waits for it, not what heals anything: the
		// recovery this row isolates already happened, at the append above.
		await manager.flush().catch(() => undefined);

		expect(notices).toHaveLength(2);
		expect(notices[1]?.text).toContain("EACCES");
	});

	it("speaks again for a second fault after a recovery through a flush", async () => {
		const { manager, storage, notices } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "first-fault", timestamp: 40 });
		await manager.flush().catch(() => undefined);
		expect(notices).toHaveLength(1);

		// The flush is the publish here: nothing is appended between the fault and it,
		// so only the atomic path can have ended the episode.
		storage.failure = undefined;
		await manager.flush();

		storage.failure = "EACCES: permission denied, write";
		manager.appendMessage({ role: "user", content: "second-fault", timestamp: 41 });
		await manager.flush().catch(() => undefined);

		expect(notices).toHaveLength(2);
		expect(notices[1]?.text).toContain("EACCES");
	});

	it("reports the current error, not a stale one, while the disk is still broken", async () => {
		const { manager, storage } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "refused", timestamp: 40 });
		await expect(manager.flush()).rejects.toThrow("ENOSPC");

		storage.failure = "EACCES: permission denied, write";
		manager.appendMessage({ role: "user", content: "refused-differently", timestamp: 41 });
		// The retry ran against the CURRENT state of the disk, so the error a caller
		// sees describes this attempt rather than the first one.
		await expect(manager.flush()).rejects.toThrow("EACCES");
	});

	it("publishes the whole transcript on the synchronous exit flush", async () => {
		const { manager, storage, file } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "pending-at-exit", timestamp: 50 });
		await manager.flush().catch(() => undefined);

		// Ctrl+C with the disk back: `flushSync` is the only publish left, and it has to
		// carry what the append could not.
		storage.failure = undefined;
		manager.flushSync();

		expect(await fs.readFile(file, "utf8")).toContain("pending-at-exit");
	});

	it("publishes the pending entries when the session closes", async () => {
		const { manager, storage, file } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "pending-at-close", timestamp: 60 });
		await manager.flush().catch(() => undefined);

		storage.failure = undefined;
		await manager.close();

		expect(await fs.readFile(file, "utf8")).toContain("pending-at-close");
	});

	it("still refuses to claim success while the disk stays broken", async () => {
		const { manager, storage, file } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "never-lands", timestamp: 70 });

		// The retry is not a promise that the write worked. A caller that asks for
		// durability is told, and the file is untouched rather than half-written.
		await expect(manager.flush()).rejects.toThrow("ENOSPC");
		expect(() => manager.flushSync()).toThrow("ENOSPC");
		const raw = await fs.readFile(file, "utf8");
		expect(raw).not.toContain("never-lands");
		expect(raw).toContain("first");
	});

	it("reloads the recovered transcript with every turn exactly once", async () => {
		const { manager, storage, file, temp } = await fixture();

		storage.failure = "ENOSPC: no space left on device, write";
		manager.appendMessage({ role: "user", content: "refused-then-saved", timestamp: 80 });
		await manager.flush().catch(() => undefined);
		storage.failure = undefined;
		manager.appendMessage(assistantMessage("last", 81));
		await manager.flush();

		// The published bytes are a session another window can open, which is the only
		// thing that makes the recovery worth anything.
		const reopened = await SessionManager.open(file, temp.path(), storage);
		const texts = reopened
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => (entry.type === "message" ? messageText(entry.message) : ""));
		expect(texts).toEqual(["first", "answer", "refused-then-saved", "last"]);
		await reopened.close();
	});

	it("writes exactly the same file when nothing ever fails", async () => {
		const { manager, file } = await fixture();

		// The positive control for the close-time publish: a clean session must not gain
		// a rewrite, and no entry may appear twice because two paths published it.
		manager.appendMessage({ role: "user", content: "clean", timestamp: 90 });
		manager.appendMessage(assistantMessage("clean-answer", 91));
		await manager.flush();
		await manager.close();

		const raw = await fs.readFile(file, "utf8");
		for (const text of ["first", "answer", "clean", "clean-answer"]) {
			expect(raw.split(`"${text}"`).length - 1).toBe(1);
		}
	});
});
