import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { buildSessionContext } from "@veyyon/coding-agent/session/session-context";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

/**
 * WHY: a compaction keeps a tail of pre-compaction entries verbatim and names the first
 * of them by id. The loader drops a record it cannot read rather than refusing the whole
 * session, so the record a keep marker names is exactly the record one half-written line
 * can remove, and the rebuild then found no marker and emitted no kept entry at all: the
 * summary made the session look whole while every kept turn was silently missing from
 * the model's context and from the transcript.
 *
 * The class this closes: real bytes on disk, opened through the real `SessionManager`,
 * cost the record that is unreadable and nothing else. The unit rows in
 * `src/session/session-context.test.ts` pin the resolution for every value the marker can
 * hold; this row is the reachability proof, that a single damaged line in a file produces
 * that value with no operator mistake anywhere.
 *
 * What it does NOT catch: the content of the dropped record, which is gone for good and
 * is what the drop notice is for.
 */

const HEADER_ID = "019f0000-0000-7000-8000-000000000000";

function messageLine(id: string, parentId: string | null, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	});
}

function userTexts(entries: SessionEntry[]): string[] {
	const out: string[] = [];
	for (const message of buildSessionContext(entries).messages) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text") out.push(part.text);
		}
	}
	return out;
}

describe("a compaction whose keep marker was dropped by the loader", () => {
	let dirOverrides: DirOverridesSnapshot | undefined;
	let agentRoot: TempDir | undefined;
	let sessionRoot: TempDir | undefined;

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		agentRoot = TempDir.createSync("@pi-keep-marker-agent-");
		setAgentDir(agentRoot.path());
		sessionRoot = TempDir.createSync("@pi-keep-marker-session-");
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await agentRoot?.remove();
		agentRoot = undefined;
		await sessionRoot?.remove();
		sessionRoot = undefined;
	});

	it("still sends the kept turns the marker can no longer name", async () => {
		const file = sessionRoot!.join("session.jsonl");
		fs.writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					version: 7,
					id: HEADER_ID,
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: sessionRoot!.path(),
				}),
				messageLine("k1", HEADER_ID, "kept one"),
				// The record the compaction names as its first kept entry, half written by a
				// process that was killed mid-append.
				'{"type":"message","id":"k2","parentId":"k1","timestamp":"2026-01-0',
				JSON.stringify({
					type: "compaction",
					id: "c1",
					parentId: "k2",
					timestamp: "2026-01-01T00:00:00.000Z",
					summary: "the summary that stands in for the discarded span",
					firstKeptEntryId: "k2",
					tokensBefore: 100,
				}),
				messageLine("a1", "c1", "after compaction"),
			].join("\n")}\n`,
		);

		const manager = await SessionManager.open(file);

		// "kept two" is genuinely gone: its line cannot be read. "kept one" is the cost the
		// old rebuild added on top of that, an entry on disk, loaded, and never sent.
		expect(userTexts(manager.getBranch())).toEqual(["kept one", "after compaction"]);
	});
});
