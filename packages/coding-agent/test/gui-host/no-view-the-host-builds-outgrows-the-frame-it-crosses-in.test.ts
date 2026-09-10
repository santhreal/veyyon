/**
 * WHY: the window's decoder treats a frame over `MAX_FRAME_BYTES` as a
 * `FramingError::FrameTooLarge` (`crates/veyyon-desktop/src/framing.rs`), and
 * the transport turns any decode error into `HostEvent::FatalProtocolError`
 * and drops the socket (`crates/veyyon-desktop/src/transport.rs`). So one view
 * that outgrew the cap did not degrade -- it ended the session's connection,
 * and reopening the pane that asked for it ended the next one.
 *
 * The defect: `changesView` returned a repository's whole unified diff and an
 * unbounded file list, and `ChangesView` carried no truncation statement,
 * alone among the views that read a workspace (`FileTreeView`,
 * `FileContentView`, `SearchResultsView` and `ContentMatchesView` all cap and
 * say so). A generated directory, a vendored tree or a large uncommitted
 * refactor was enough.
 *
 * CLASS CLOSED: two ways, at two levels.
 *   - Per view: the changes builder holds to a byte budget for the diff and a
 *     count for the files, cuts the diff on a file, hunk or line boundary, and
 *     states both cuts on the wire.
 *   - For every view, including the ones with no budget yet: `writeFrame` is
 *     the one place a host frame is written, and it refuses a payload over the
 *     cap rather than handing the window a fatal frame. A request whose
 *     snapshot is refused fails with a reason the pane draws, and the socket
 *     stays up for every other view.
 *
 * The sweep below asks the host for every workspace view against a hostile
 * repository -- 2,100 untracked files and a tracked diff past the budget --
 * and reads the byte size of every frame that came back off the wire.
 *
 * Not caught: a view whose payload exceeds the cap and whose handler writes it
 * with `writeFrame` directly rather than through `ctx.reply.snapshot` states
 * nothing to the window; the frame is refused and logged, and the pane waits.
 * `Transcript` and `Export` still carry a whole session with no budget of
 * their own, which is why the refusal is proved here through `LoadTranscript`
 * rather than assumed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { CHANGES_MAX_DIFF_BYTES, CHANGES_MAX_FILES } from "../../src/gui-host/actions/changes";
import { MAX_FRAME_BYTES, writeFrame } from "../../src/gui-host/frames";
import type { ChangesView } from "../../src/gui-host/wire";
import { snapshotSections, TestSocketClient } from "./test-client";

/** Files the seeded repository tracks, each rewritten line for line. */
const TRACKED_FILES = 24;
/** Lines per tracked file. The corpus replaces ~5 MiB of diff text. */
const LINES_PER_FILE = 4_000;
/** Untracked files, past `CHANGES_MAX_FILES` on their own. */
const UNTRACKED_FILES = 2_100;

function git(cwd: string, ...args: string[]): Promise<number> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
	return proc.exited;
}

/** A file body of `lines` numbered lines, `text` on each. */
function body(lines: number, text: string): string {
	let out = "";
	for (let line = 0; line < lines; line += 1) {
		out += `const ENTRY_${String(line).padStart(4, "0")}_${text} = ${line};\n`;
	}
	return out;
}

/**
 * Every hunk in a unified diff, with the line counts it claims and the lines
 * that follow it.
 *
 * The window's parser numbers every row of a file from these counts
 * (`crates/veyyon-desktop-surface/src/diff/parse.rs`), so a diff cut inside a
 * hunk body arrives as a hunk that lies about its own contents.
 */
function hunks(diff: string): Array<{ header: string; oldCount: number; newCount: number; old: number; new: number }> {
	const out: Array<{ header: string; oldCount: number; newCount: number; old: number; new: number }> = [];
	for (const line of diff.split("\n")) {
		const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
		if (header) {
			out.push({
				header: line,
				oldCount: header[1] === undefined ? 1 : Number.parseInt(header[1], 10),
				newCount: header[2] === undefined ? 1 : Number.parseInt(header[2], 10),
				old: 0,
				new: 0,
			});
			continue;
		}
		if (line.startsWith("diff --git ")) {
			// A file's own header lines sit between its `diff --git` and its
			// first hunk, and they start with the signs a hunk body uses.
			out.push({ header: "", oldCount: 0, newCount: 0, old: 0, new: 0 });
			continue;
		}
		const hunk = out.at(-1);
		if (!hunk || hunk.header === "") continue;
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) hunk.new += 1;
		else if (line.startsWith("-")) hunk.old += 1;
		else if (line.startsWith(" ")) {
			hunk.old += 1;
			hunk.new += 1;
		}
	}
	// The sentinels a `diff --git` line pushes are not hunks.
	return out.filter(hunk => hunk.header !== "");
}

describe("no view the host builds outgrows the frame it crosses in", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-oversized-frame-"));
		await git(tempDir, "init");
		await git(tempDir, "config", "user.name", "Test User");
		await git(tempDir, "config", "user.email", "test@example.com");

		for (let file = 0; file < TRACKED_FILES; file += 1) {
			await fs.writeFile(path.join(tempDir, `tracked_${file}.rs`), body(LINES_PER_FILE, "OLD"), "utf8");
		}
		await git(tempDir, "add", ".");
		await git(tempDir, "commit", "-m", "initial commit");
		// Every line of every tracked file changes, so the diff is twice the
		// corpus: the budget is reached by content the operator really has.
		for (let file = 0; file < TRACKED_FILES; file += 1) {
			await fs.writeFile(path.join(tempDir, `tracked_${file}.rs`), body(LINES_PER_FILE, "NEW"), "utf8");
		}
		await Promise.all(
			Array.from({ length: UNTRACKED_FILES }, (_unused, index) =>
				fs.writeFile(path.join(tempDir, `untracked_${String(index).padStart(5, "0")}.txt`), "one\ntwo\n", "utf8"),
			),
		);

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

	test("the one place a frame is written refuses a payload over the cap", async () => {
		// A real socket pair: the cap belongs to the byte stream, and a double
		// that counted calls would prove nothing about what crossed it.
		const received: Buffer[] = [];
		const { promise: drained, resolve: onEnd } = Promise.withResolvers<void>();
		const { promise: connected, resolve: onConnection } = Promise.withResolvers<void>();
		const sink = net.createServer(socket => {
			socket.on("data", chunk => received.push(Buffer.from(chunk)));
			socket.on("end", () => onEnd());
		});
		await new Promise<void>(resolve => sink.listen(0, "127.0.0.1", resolve));
		const address = sink.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		const source = net.connect({ host: "127.0.0.1", port }, () => onConnection());
		await connected;

		try {
			const fits = { Snapshot: { FileContent: { content: "x".repeat(1024) } } };
			expect(writeFrame(source, fits)).toBe(true);

			// One byte of content past the cap, envelope included.
			const envelope = Buffer.byteLength(`${JSON.stringify({ Snapshot: { FileContent: { content: "" } } })}\n`);
			const oversized = { Snapshot: { FileContent: { content: "y".repeat(MAX_FRAME_BYTES - envelope + 1) } } };
			expect(writeFrame(source, oversized)).toBe(false);

			// The reading is what arrived at the other end, so the stream is
			// closed and drained before it is counted.
			source.end();
			await drained;

			const written = Buffer.concat(received).toString("utf8");
			expect(written).toContain("x".repeat(1024));
			expect(written).not.toContain("yyyy");
			expect(written.split("\n").filter(line => line.length > 0)).toHaveLength(1);
		} finally {
			source.destroy();
			await new Promise<void>(resolve => sink.close(() => resolve()));
		}
	});

	test("a hostile workspace states its changes inside one frame, and says what it cut", async () => {
		const { frames, outcome } = await client.request(1, "RefreshChanges");
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const changes = snapshotSections<ChangesView>(frames, "Changes");
		expect(changes).toHaveLength(1);
		const view = changes[0];

		// The cut is stated, not silent.
		expect(view.diff_truncated).toBe(true);
		expect(Buffer.byteLength(view.diff, "utf8")).toBeLessThanOrEqual(CHANGES_MAX_DIFF_BYTES);
		expect(view.files).toHaveLength(CHANGES_MAX_FILES);
		// 2,100 untracked plus 8 modified, less what one frame carries.
		expect(view.files_withheld).toBe(UNTRACKED_FILES + TRACKED_FILES - CHANGES_MAX_FILES);

		// The whole exchange fits the window's decoder, which is the reading
		// that decides whether the connection survives.
		expect(client.largestFrameBytes()).toBeLessThanOrEqual(MAX_FRAME_BYTES);
	});

	test("the diff it cut ends on a boundary the window's parser can read", async () => {
		const { frames } = await client.request(1, "RefreshChanges");
		const view = snapshotSections<ChangesView>(frames, "Changes")[0];

		// Every hunk carries the lines its header claims, including the last
		// one before the cut.
		for (const hunk of hunks(view.diff)) {
			expect({ header: hunk.header, old: hunk.old, new: hunk.new }).toEqual({
				header: hunk.header,
				old: hunk.oldCount,
				new: hunk.newCount,
			});
		}
		// A cut mid-line would leave the text without its closing newline.
		expect(view.diff.endsWith("\n")).toBe(true);
		// And it cut on a boundary between files, so the text does not end on a
		// header whose body the window will never receive.
		expect(view.diff.split("diff --git ").length - 1).toBeGreaterThan(1);
		const lastLine = view.diff.trimEnd().split("\n").at(-1) ?? "";
		for (const header of ["diff --git ", "index ", "--- ", "+++ ", "@@ "]) {
			expect(lastLine.startsWith(header)).toBe(false);
		}
	});

	test("switching scope on a hostile workspace stays inside one frame too", async () => {
		await git(tempDir, "add", "tracked_0.rs");
		const { frames, outcome } = await client.request(1, { SelectChangeScope: { scope: "Staged" } });
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const view = snapshotSections<ChangesView>(frames, "Changes").at(-1);
		expect(view?.scope).toBe("Staged");
		expect(client.largestFrameBytes()).toBeLessThanOrEqual(MAX_FRAME_BYTES);
	});

	test("a view with no budget of its own fails its request instead of the connection", async () => {
		// `Transcript` carries a whole session. One message past the cap is the
		// state a long session with large tool results reaches on its own.
		const storage = new FileSessionStorage();
		const sessionDir = computeDefaultSessionDir(tempDir, storage, path.join(tempDir, "sessions"));
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "z".repeat(MAX_FRAME_BYTES + 1_024) }],
			timestamp: 1_700_000_000_000,
		});
		await sm.ensureOnDisk();
		await sm.flush();

		const loaded = await client.request(1, { LoadTranscript: { session: sm.getSessionId(), before: null } });
		expect(loaded.outcome.RequestFailed?.request).toBe(1);
		expect(loaded.outcome.RequestFailed?.error.code).toBe("SNAPSHOT_TOO_LARGE");
		expect(loaded.outcome.RequestFailed?.error.retryable).toBe(false);
		expect(loaded.outcome.RequestFailed?.error.message).toContain("Transcript");
		// One outcome, not a failure followed by the success the handler went
		// on to report.
		expect(loaded.frames.filter(frame => frame.RequestSucceeded?.request === 1)).toEqual([]);

		// The connection is the thing that used to die. Another view answers on
		// the same socket.
		const after = await client.request(2, "RefreshChanges");
		expect(after.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(client.largestFrameBytes()).toBeLessThanOrEqual(MAX_FRAME_BYTES);
	});
});
