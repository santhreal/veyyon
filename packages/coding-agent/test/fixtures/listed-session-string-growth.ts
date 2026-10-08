/**
 * Lists a directory of sessions whose message text is far past the row bound and prints, as JSON, the
 * string bytes the listed rows left live in the process that runs this file. argv[2] is the directory
 * to write the sessions under. Prints the rows listed, the characters of text they hold, the bytes of
 * the session files the scan read, and the string bytes the listing left live.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { listSessionsReadOnly } from "@veyyon/kernel/session/session-listing";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { postmortem } from "@veyyon/utils";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";

export interface ListGrowth {
	rows: number;
	heldChars: number;
	scannedBytes: number;
	grown: number;
}

const SESSIONS = 16;
const TS = "2026-07-22T00:00:00.000Z";

/**
 * One session file the scan escalates for: a 100,000-character entry hides the first user message past
 * the head window, and a 600,000-character reply follows it. The row's text is cut from the join of
 * the two messages.
 */
function writeSession(dir: string, seed: number, replyChars: number): string {
	const file = path.join(dir, `session-${seed}.jsonl`);
	const lines = [
		{ type: "session", id: `session-${seed}`, cwd: "/repo", timestamp: TS },
		{ type: "custom", payload: "x".repeat(100_000), timestamp: TS },
		{ type: "message", message: { role: "user", content: `question ${seed}` } },
		{ type: "message", message: { role: "assistant", content: `reply ${seed}: `.padEnd(replyChars, `${seed}`) } },
	];
	fs.writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

async function measure(dir: string): Promise<ListGrowth> {
	const listed = path.join(dir, "listed");
	const warm = path.join(dir, "warm");
	fs.mkdirSync(listed, { recursive: true });
	fs.mkdirSync(warm, { recursive: true });
	let scannedBytes = 0;
	for (let seed = 0; seed < SESSIONS; seed++) scannedBytes += fs.statSync(writeSession(listed, seed, 600_000)).size;
	writeSession(warm, -1, 10_000);
	const storage = new FileSessionStorage();
	// A throwaway listing of one session loads every module the measured listing reaches.
	await listSessionsReadOnly(warm, storage);

	const before = await liveStringBytes();
	const rows = await listSessionsReadOnly(listed, storage);
	const grown = (await liveStringBytes()) - before;
	const heldChars = rows.reduce((sum, row) => sum + row.firstMessage.length + row.allMessagesText.length, 0);
	return { rows: rows.length, heldChars, scannedBytes, grown };
}

try {
	const [dir] = process.argv.slice(2);
	if (!dir) throw new Error("usage: listed-session-string-growth.ts <dir>");
	process.stdout.write(`${JSON.stringify(await measure(dir))}\n`);
} finally {
	await postmortem.cleanup();
}
