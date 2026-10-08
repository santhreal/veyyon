/**
 * Opens a session of distinct large texts and prints, as JSON, the string bytes the open left live in
 * the process that runs this file. argv[2] is the directory to record the session under, argv[3] the
 * number of texts and argv[4] the characters in each. Prints the bytes of the texts, the file's size,
 * the string bytes the open left live, and the entries loaded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem } from "@veyyon/utils";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";
import { createAssistantMessage } from "../helpers/agent-session-setup";

export interface OpenGrowth {
	textBytes: number;
	size: number;
	grown: number;
	entries: number;
}

/** `chars` characters distinct per `seed`, so the loader's string pool shares none of them. */
function text(seed: number, chars: number): string {
	return `text ${seed}: `.padEnd(chars, `abcdefghij${seed}`);
}

/** A session file of one assistant message per text: a file is written once it holds a reply. */
async function record(dir: string, texts: readonly string[]): Promise<string> {
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	for (const content of texts) manager.appendMessage(createAssistantMessage(content));
	await manager.flush();
	return manager.getSessionFile() as string;
}

async function measure(dir: string, count: number, chars: number): Promise<OpenGrowth> {
	const texts = Array.from({ length: count }, (_, seed) => text(seed, chars));
	const file = await record(dir, texts);
	// A throwaway open of a small session loads every module the measured open reaches.
	await SessionManager.open(await record(dir, [text(-1, 100)]));

	const before = await liveStringBytes();
	const manager = await SessionManager.open(file);
	const grown = (await liveStringBytes()) - before;
	return { textBytes: count * chars, size: fs.statSync(file).size, grown, entries: manager.getEntries().length };
}

try {
	const [dir, count, chars] = process.argv.slice(2);
	if (!dir || !count || !chars) throw new Error("usage: loaded-session-string-growth.ts <dir> <texts> <chars>");
	process.stdout.write(`${JSON.stringify(await measure(dir, Number(count), Number(chars)))}\n`);
} finally {
	await postmortem.cleanup();
}
