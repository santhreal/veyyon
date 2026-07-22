import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalSnapshotKey,
	getFileSnapshotStore,
	parseSeenLinesFromHashlineBody,
	recordSeenLinesFromBody,
} from "@veyyon/coding-agent/edit/file-snapshot-store";
import type { InMemorySnapshotStore } from "@veyyon/hashline";

interface SessionOwner {
	fileSnapshotStore?: InMemorySnapshotStore;
}

describe("canonicalSnapshotKey", () => {
	it("collapses symlink-equivalent forms (macOS /tmp ↔ /private/tmp) onto one key", async () => {
		// `os.tmpdir()` returns the realpath on macOS; mkdtemp under it gives us a
		// real directory that we can address via both /tmp/... and /private/tmp/...
		// when the platform has that symlink. Skip the assertion when it doesn't.
		const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-key-"));
		const filePath = path.join(realDir, "a.txt");
		await Bun.write(filePath, "x\n");

		const k1 = canonicalSnapshotKey(filePath);
		// If realDir already starts at the symlink target form, k1 === filePath
		// — that's also valid behavior. Either way both spellings MUST round-trip
		// to the same canonical key.
		expect(canonicalSnapshotKey(k1)).toBe(k1);

		// Construct the alternate spelling for tmpdir if /tmp -> /private/tmp.
		if (filePath.startsWith("/private/")) {
			const alt = filePath.slice("/private".length);
			expect(canonicalSnapshotKey(alt)).toBe(k1);
		}
	});

	it("falls back to parent realpath + basename for non-existent paths", async () => {
		const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-key-"));
		const missing = path.join(realDir, "does-not-exist.txt");
		// Snapshot key is still computable (used for write-then-snapshot flow).
		const key = canonicalSnapshotKey(missing);
		expect(key).toBe(path.join(canonicalSnapshotKey(realDir), "does-not-exist.txt"));
	});

	it("returns the input unchanged when nothing in the chain exists", () => {
		const key = canonicalSnapshotKey("/__definitely-not-a-real-path__/x/y/z.txt");
		expect(key).toBe("/__definitely-not-a-real-path__/x/y/z.txt");
	});
});

describe("snapshot store fusion via canonical keys", () => {
	it("records and looks up the same snapshot regardless of /tmp vs /private/tmp spelling", async () => {
		const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-fuse-"));
		const filePath = path.join(realDir, "a.txt");
		await Bun.write(filePath, "x\n");

		const session: SessionOwner = {};
		const store = getFileSnapshotStore(session);
		const hash = store.record(canonicalSnapshotKey(filePath), "x\n");

		// The hash MUST be retrievable via every path spelling that points at
		// the same file content (covers the patcher looking up a tag the read
		// tool minted under a different spelling).
		expect(store.byHash(canonicalSnapshotKey(filePath), hash)?.text).toBe("x\n");
		if (filePath.startsWith("/private/")) {
			const alt = filePath.slice("/private".length);
			expect(store.byHash(canonicalSnapshotKey(alt), hash)?.text).toBe("x\n");
		}
	});
});

describe("parseSeenLinesFromHashlineBody", () => {
	it("collects single NN: line numbers and skips the header and footer rows", () => {
		const body = ["[src/x.ts#1A2B]", "300:function f() {", "301:\treturn 1;", "302:}", "[…2ln elided; …]"].join("\n");
		expect(parseSeenLinesFromHashlineBody(body)).toEqual([300, 301, 302]);
	});

	it("adds only the boundary lines of a collapsed NN-MM: summary row, never the interior", () => {
		const body = [
			"30-39:export interface Snapshot { … }",
			"40:",
			"46-61:export abstract class SnapshotStore { … }",
		].join("\n");
		expect(parseSeenLinesFromHashlineBody(body)).toEqual([30, 39, 40, 46, 61]);
	});

	it("anchors the prefix at line start, ignoring colons inside line content", () => {
		expect(parseSeenLinesFromHashlineBody("305:const t = a ? 1 : 2; // 42: note")).toEqual([305]);
	});

	it("tolerates grep `*`/space match markers before the line number (search/ast-grep output)", () => {
		const body = ["*73:matched line", " 74:context line", "…", " 75:more context"].join("\n");
		expect(parseSeenLinesFromHashlineBody(body)).toEqual([73, 74, 75]);
	});
});

/**
 * recordSeenLinesFromBody is the wiring that turns a displayed hashline body into the snapshot's
 * seen-line set: it parses the body's `NN:` prefixes, optionally prunes column-truncated lines the
 * model only partially saw, and merges the survivors into the snapshot the read minted. It had no
 * direct test. The contracts pinned here are the ones the patcher's seen-line guard depends on:
 *   - the parsed line numbers land in the snapshot's `seenLines` set under its tag;
 *   - `excludedLines` removes exactly those column-truncated lines before recording, so a partially
 *     shown line is NOT marked seen (the guard must keep rejecting edits against it);
 *   - a body with no numbered rows records nothing (best-effort no-op, seenLines stays undefined);
 *   - an unknown/aged-out tag is a silent no-op, never a throw.
 * A regression that skipped the exclusion or recorded under the wrong tag would let the patcher accept
 * an edit anchored on a line the model never fully read.
 */
describe("recordSeenLinesFromBody", () => {
	const seedSnapshot = (): { session: SessionOwner; key: string; tag: string } => {
		const session: SessionOwner = {};
		const store = getFileSnapshotStore(session);
		// A stable absolute path that need not exist on disk: canonicalSnapshotKey
		// falls back to the input, and the store keys purely off that string.
		const absPath = "/snap-seen/only.ts";
		const key = canonicalSnapshotKey(absPath);
		const tag = store.record(key, "l1\nl2\nl3\n");
		return { session, key, tag };
	};

	const seenFor = (session: SessionOwner, key: string, tag: string): number[] => {
		const set = getFileSnapshotStore(session).byHash(key, tag)?.seenLines;
		return set ? [...set].sort((a, b) => a - b) : [];
	};

	it("merges the body's parsed line numbers into the snapshot's seenLines under its tag", () => {
		const { session, key, tag } = seedSnapshot();
		recordSeenLinesFromBody(session, "/snap-seen/only.ts", tag, ["10:x", "11:y", "12:z"].join("\n"));
		expect(seenFor(session, key, tag)).toEqual([10, 11, 12]);
	});

	it("prunes column-truncated lines listed in excludedLines before recording", () => {
		const { session, key, tag } = seedSnapshot();
		recordSeenLinesFromBody(session, "/snap-seen/only.ts", tag, ["20:a", "21:b"].join("\n"), new Set([21]));
		expect(seenFor(session, key, tag)).toEqual([20]);
	});

	it("records nothing when the body has no numbered rows", () => {
		const { session, key, tag } = seedSnapshot();
		recordSeenLinesFromBody(session, "/snap-seen/only.ts", tag, "no numbered rows here");
		expect(getFileSnapshotStore(session).byHash(key, tag)?.seenLines).toBeUndefined();
	});

	it("is a silent no-op for an unknown tag", () => {
		const { session } = seedSnapshot();
		expect(() => recordSeenLinesFromBody(session, "/snap-seen/only.ts", "deadbeef", "5:x")).not.toThrow();
	});
});
