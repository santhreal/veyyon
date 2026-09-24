import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BlobStore, externalizeTextSync } from "@veyyon/kernel/session/blob-store";
import { type OperatorNotice, OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { loadSessionMessagesReadOnly } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getBlobsDir, getSessionsDir, setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

/**
 * WHY: persistence moves a payload over 500k characters out of the session line into the
 * blob store and leaves a `blobtext:sha256:…` reference. Every read and write went to the
 * ACTIVE profile's store, whatever profile the session file came from. Resuming another
 * profile's session by path then found none of its payloads (hundreds of "Blob not found"
 * warnings per load and a transcript of bare references), and every payload the resumed
 * session wrote landed in the active profile's store, where that profile's `gc --blobs`
 * scans only its own sessions, counts the payload unreferenced, and deletes it.
 *
 * The class this closes: a session file's payloads are read from and written to the store
 * beside the `sessions` root holding the file. Each load path (open, read-only load, fork)
 * and the write path are driven against a file in a second profile, and a file in the
 * active profile is the control that keeps using the active store.
 *
 * What it does NOT catch: a session directory outside any `sessions` root, which has no
 * store of its own and uses the active one; and a payload already written to the wrong
 * store before this fix, which stays where it was written.
 */

const HEADER_ID = "019f0000-0000-7000-8000-00000000c0de";
const BIG = 500_001;

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function sessionFile(dir: string, text: string, cwd = dir): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${HEADER_ID}.jsonl`);
	const header = { type: "session", version: 7, id: HEADER_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd };
	const entry = {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	};
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
	return file;
}

function firstText(record: FileEntry | undefined): string | undefined {
	if (record?.type !== "message") return undefined;
	const content = "content" in record.message ? record.message.content : undefined;
	if (!Array.isArray(content)) return undefined;
	const first = content[0];
	return first?.type === "text" ? first.text : undefined;
}

function holds(dir: string, text: string): boolean {
	return fs.existsSync(path.join(dir, sha256(text)));
}

describe("a session from another profile keeps its own blob store", () => {
	let dirOverrides: DirOverridesSnapshot | undefined;
	let active: TempDir | undefined;
	let other: TempDir | undefined;
	let otherBlobs = "";
	let otherSessionDir = "";
	const stored = "s".repeat(BIG);

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		active = TempDir.createSync("@pi-blob-profile-active-");
		other = TempDir.createSync("@pi-blob-profile-other-");
		setAgentDir(active.path());
		otherBlobs = other.join("blobs");
		otherSessionDir = other.join("sessions", "--project--");
		expect(externalizeTextSync(new BlobStore(otherBlobs), stored)).toBe(`blobtext:sha256:${sha256(stored)}`);
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await active?.remove();
		await other?.remove();
		active = undefined;
		other = undefined;
	});

	it("opens with every payload the file's own store holds, and reports no loss", async () => {
		const seen: OperatorNotice[] = [];
		const file = sessionFile(otherSessionDir, `blobtext:sha256:${sha256(stored)}`);

		const manager = await SessionManager.open(file, undefined, undefined, {
			operatorNotices: new OperatorNotices(notice => seen.push(notice)),
			suppressBreadcrumb: true,
		});
		try {
			expect({ text: firstText(manager.getBranch()[0])?.length, notices: seen }).toEqual({
				text: BIG,
				notices: [],
			});
		} finally {
			await manager.close();
		}
	});

	it("loads read-only from the file's own store", async () => {
		const file = sessionFile(otherSessionDir, `blobtext:sha256:${sha256(stored)}`);

		const [message] = await loadSessionMessagesReadOnly(file);
		const content = message && "content" in message ? message.content : undefined;
		expect(Array.isArray(content) && content[0]?.type === "text" ? content[0].text.length : undefined).toBe(BIG);
	});

	it("forks from the source's store into the fork's own store", async () => {
		const file = sessionFile(otherSessionDir, `blobtext:sha256:${sha256(stored)}`);
		const forkDir = path.join(getSessionsDir(), "--fork--");

		const fork = await SessionManager.forkFrom(file, forkDir, forkDir, undefined, { suppressBreadcrumb: true });
		try {
			await fork.flush();
			expect({
				text: firstText(fork.getBranch()[0])?.length,
				inActiveStore: holds(getBlobsDir(), stored),
			}).toEqual({ text: BIG, inActiveStore: true });
		} finally {
			await fork.close();
		}
	});

	it("writes a new payload beside the file it belongs to", async () => {
		const file = sessionFile(otherSessionDir, `blobtext:sha256:${sha256(stored)}`);
		const written = "w".repeat(BIG);

		const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: written }], timestamp: 2 });
			await manager.flush();
		} finally {
			await manager.close();
		}

		expect({
			inOwnStore: holds(otherBlobs, written),
			inActiveStore: holds(getBlobsDir(), written),
			referenced: fs.readFileSync(file, "utf8").includes(`blobtext:sha256:${sha256(written)}`),
		}).toEqual({ inOwnStore: true, inActiveStore: false, referenced: true });
	});

	it("switches a running session to the file's own store for reads and writes", async () => {
		// The header names a project that no longer exists, so the switch keeps the
		// running session's directory and only the file moves to the other profile.
		const file = sessionFile(otherSessionDir, `blobtext:sha256:${sha256(stored)}`, other!.join("gone"));
		const before = "b".repeat(BIG);
		const after = "c".repeat(BIG);
		const activeSessionDir = path.join(getSessionsDir(), "--project--");

		const manager = SessionManager.create(activeSessionDir, activeSessionDir);
		try {
			// A payload the running session stored before the switch stays where it went.
			manager.putBlobSync(Buffer.from(before, "utf8"));
			await manager.setSessionFile(file);
			const resumed = firstText(manager.getBranch()[0])?.length;
			manager.appendMessage({ role: "user", content: [{ type: "text", text: after }], timestamp: 3 });
			await manager.flush();
			expect({
				resumed,
				beforeInActive: holds(getBlobsDir(), before),
				afterInOwn: holds(otherBlobs, after),
				afterInActive: holds(getBlobsDir(), after),
			}).toEqual({ resumed: BIG, beforeInActive: true, afterInOwn: true, afterInActive: false });
		} finally {
			await manager.close();
		}
	});

	it("writes to the active store from a sessions root with no store beside it", async () => {
		using bare = TempDir.createSync("@pi-blob-profile-bare-");
		const file = sessionFile(bare.join("sessions", "--project--"), "short");
		const written = "n".repeat(BIG);

		const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: written }], timestamp: 2 });
			await manager.flush();
		} finally {
			await manager.close();
		}

		expect({ inActiveStore: holds(getBlobsDir(), written), storeBeside: fs.existsSync(bare.join("blobs")) }).toEqual({
			inActiveStore: true,
			storeBeside: false,
		});
	});

	it("keeps a session of the active profile on the active store", async () => {
		const activeSessionDir = path.join(getSessionsDir(), "--project--");
		const file = sessionFile(activeSessionDir, "short");
		const written = "a".repeat(BIG);

		const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: written }], timestamp: 2 });
			await manager.flush();
		} finally {
			await manager.close();
		}

		expect({ inActiveStore: holds(getBlobsDir(), written), inOtherStore: holds(otherBlobs, written) }).toEqual({
			inActiveStore: true,
			inOtherStore: false,
		});
	});
});
