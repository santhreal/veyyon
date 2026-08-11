import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type OperatorNotice, OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import type { FileEntry } from "@veyyon/coding-agent/session/session-entries";
import { loadEntriesFromFileStream, parseSessionContent } from "@veyyon/coding-agent/session/session-loader";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { isRecord, setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

/**
 * WHY: entries form a tree keyed by `parentId`, and the branch walk climbs from a leaf
 * to the header, so an entry whose parent is missing from the file is where that climb
 * stops. The loader already drops a record it cannot read (a half-written line from a
 * killed process, a shape this build refuses) and says so, and nothing re-linked the
 * record after it: measured on a four-entry transcript with one unreadable line, the
 * branch came back holding only the two entries after the gap, so a one-record loss
 * silently took the beginning of the conversation with it. Everything was still on disk
 * and still loaded; it was unreachable.
 *
 * The class this closes: a break in the parent chain costs the records that are
 * unreadable and NOTHING else. The rows drive both parse paths (the in-memory parse and
 * the >=8MiB streaming parse, which is a separate copy of the same loop), damage in the
 * middle, a run of damage, damage with no drop at all, and the repair reaching disk on
 * the next publish. Row "keeps a real tree" is the control that stops the repair from
 * being a flatten: a transcript that is legitimately a tree (two windows appending at
 * once) must come back with its siblings intact.
 *
 * What it does NOT catch: a file whose HEADER line is the unreadable one, which has no
 * record in front of it to re-link to and is handled by the missing-header path; and the
 * content of a dropped record, which is gone for good and is what the drop notice is
 * for.
 */

function header(id: string, cwd: string): Record<string, unknown> {
	return { type: "session", version: 7, id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

function messageEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

/** An assistant record whose content is a string: loadable JSON, refused shape. */
function wrongShapeEntry(id: string, parentId: string): Record<string, unknown> {
	const entry = messageEntry(id, parentId, "unused");
	(entry.message as Record<string, unknown>).content = "a string, not an array of blocks";
	return entry;
}

function texts(entries: readonly FileEntry[]): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		out.push(
			message.content.map(block => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join(""),
		);
	}
	return out;
}

/**
 * Texts a branch walk can reach: climb `parentId` from the last record to the header,
 * the way `SessionManager.getBranch` does, and read the chain back in file order. A
 * break in the chain shortens this list, which is the loss the suite is about; reading
 * the loaded array in file order cannot see it, because a stranded record is still in
 * the array.
 */
function reachableTexts(entries: readonly FileEntry[]): string[] {
	const byId = new Map<string, FileEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	const chain: FileEntry[] = [];
	let cursor: FileEntry | undefined = entries[entries.length - 1];
	while (cursor) {
		chain.push(cursor);
		const parentId: string | null | undefined = "parentId" in cursor ? cursor.parentId : null;
		cursor = parentId === null || parentId === undefined ? undefined : byId.get(parentId);
	}
	return texts(chain.reverse());
}

const HEADER_ID = "019f0000-0000-7000-8000-000000000000";

/** A transcript of four assistant turns with `damage` spliced in after the first. */
function damagedContent(cwd: string, damage: readonly string[]): string {
	const lines = [
		JSON.stringify(header(HEADER_ID, cwd)),
		JSON.stringify(messageEntry("e1", HEADER_ID, "first")),
		...damage,
		JSON.stringify(messageEntry("e3", "e2", "third")),
		JSON.stringify(messageEntry("e4", "e3", "fourth")),
	];
	return `${lines.join("\n")}\n`;
}

describe("a broken parent chain costs only the records that cannot be read", () => {
	let dirOverrides: DirOverridesSnapshot | undefined;
	let agentRoot: TempDir | undefined;

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		agentRoot = TempDir.createSync("@pi-stitch-agent-");
		setAgentDir(agentRoot.path());
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await agentRoot?.remove();
		agentRoot = undefined;
	});

	it("keeps the turns before an unreadable line reachable", () => {
		const { entries } = parseSessionContent(damagedContent("/tmp/x", ["{ not json at all"]));
		expect(reachableTexts(entries)).toEqual(["first", "third", "fourth"]);
		expect(entries.map(entry => ("parentId" in entry ? entry.parentId : null))).toEqual([
			null,
			HEADER_ID,
			"e1",
			"e3",
		]);
	});

	it("keeps them reachable when the line is loadable JSON of a refused shape", () => {
		const { entries } = parseSessionContent(damagedContent("/tmp/x", [JSON.stringify(wrongShapeEntry("e2", "e1"))]));
		expect(reachableTexts(entries)).toEqual(["first", "third", "fourth"]);
	});

	it("links across a run of unreadable lines", () => {
		const { entries } = parseSessionContent(
			damagedContent("/tmp/x", ["{ broken one", "{ broken two", JSON.stringify(wrongShapeEntry("e2", "e1"))]),
		);
		expect(reachableTexts(entries)).toEqual(["first", "third", "fourth"]);
		expect(entries[2] && "parentId" in entries[2] ? entries[2].parentId : undefined).toBe("e1");
	});

	it("links an orphan that arrived with no record dropped", () => {
		// A parent id no line in the file carries: a foreign writer's tail that was cut,
		// or a publish that lost a record before this one was appended.
		const content = `${[
			JSON.stringify(header(HEADER_ID, "/tmp/x")),
			JSON.stringify(messageEntry("e1", HEADER_ID, "first")),
			JSON.stringify(messageEntry("e2", "never-written", "second")),
		].join("\n")}\n`;
		const { entries } = parseSessionContent(content);
		expect(reachableTexts(entries)).toEqual(["first", "second"]);
		expect(entries[2] && "parentId" in entries[2] ? entries[2].parentId : undefined).toBe("e1");
	});

	it("keeps a real tree, rather than flattening it", () => {
		const content = `${[
			JSON.stringify(header(HEADER_ID, "/tmp/x")),
			JSON.stringify(messageEntry("e1", HEADER_ID, "first")),
			JSON.stringify(messageEntry("e2a", "e1", "one way")),
			JSON.stringify(messageEntry("e2b", "e1", "the other way")),
		].join("\n")}\n`;
		const { entries } = parseSessionContent(content);
		expect(entries.map(entry => ("parentId" in entry ? entry.parentId : null))).toEqual([
			null,
			HEADER_ID,
			"e1",
			"e1",
		]);
	});

	it("leaves a root record alone, and stays quiet about a whole file", () => {
		// `parentId: null` is how a producer spells "this record is a root", which a legacy
		// migration and the first turn both write. Reading it as a lost parent re-parents a
		// healthy record and diagnoses every undamaged session ever opened.
		const seen: OperatorNotice[] = [];
		const notices = new OperatorNotices(notice => seen.push(notice));
		const content = `${[
			JSON.stringify(header(HEADER_ID, "/tmp/x")),
			JSON.stringify({ ...messageEntry("e1", HEADER_ID, "first"), parentId: null }),
			JSON.stringify(messageEntry("e2", "e1", "second")),
		].join("\n")}\n`;
		const { entries } = parseSessionContent(content, { source: "healthy.jsonl", operatorNotices: notices });
		const root = entries[1];
		expect(root && "parentId" in root ? root.parentId : "no parentId field").toBeNull();
		const child = entries[2];
		expect(child && "parentId" in child ? child.parentId : undefined).toBe("e1");
		expect(seen).toEqual([]);
	});

	it("repairs the streaming parse path too", async () => {
		using temp = TempDir.createSync("@pi-stitch-stream-");
		const file = temp.join("stream.jsonl");
		fs.writeFileSync(file, damagedContent(temp.path(), ["{ not json at all"]));
		const { entries } = await loadEntriesFromFileStream(file);
		expect(reachableTexts(entries)).toEqual(["first", "third", "fourth"]);
		expect(entries[2] && "parentId" in entries[2] ? entries[2].parentId : undefined).toBe("e1");
	});

	it("says what was re-linked and what that means", () => {
		const seen: OperatorNotice[] = [];
		const notices = new OperatorNotices(notice => seen.push(notice));
		parseSessionContent(damagedContent("/tmp/x", ["{ not json at all"]), {
			source: "session-under-test.jsonl",
			operatorNotices: notices,
		});
		const relink = seen.find(notice => notice.text.includes("Re-linked"));
		expect(relink?.severity).toBe("warning");
		expect(relink?.source).toBe("session");
		expect(relink?.text).toContain("Re-linked 1 record");
		expect(relink?.text).toContain("session-under-test.jsonl");
		expect(relink?.text).toContain("still part of this conversation");
		// The drop is still reported: the unreadable record itself is gone for good.
		expect(seen.some(notice => notice.text.includes("malformed record"))).toBe(true);
	});

	it("delivers the whole conversation through a real session, and repairs the file", async () => {
		using temp = TempDir.createSync("@pi-stitch-session-");
		const dir = temp.join("sessions");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `2026-01-01T00-00-00-000Z_${HEADER_ID}.jsonl`);
		fs.writeFileSync(file, damagedContent(temp.path(), ["{ not json at all"]));

		const manager = await SessionManager.open(file);
		expect(texts(manager.getBranch())).toEqual(["first", "third", "fourth"]);

		// The next publish writes the repair, so the damage is not re-diagnosed forever.
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "fifth" }],
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		await manager.flush();

		const reopened = await SessionManager.open(file);
		expect(texts(reopened.getBranch())).toEqual(["first", "third", "fourth", "fifth"]);
		const republished = parseSessionContent(fs.readFileSync(file, "utf8")).entries;
		const third = republished.find(entry => entry.id === "e3");
		expect(third && "parentId" in third ? third.parentId : undefined).toBe("e1");
	});
});
