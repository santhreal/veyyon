import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeEditDiff } from "@veyyon/coding-agent/edit/diff";
import { clearPreviewTextCache } from "@veyyon/coding-agent/edit/preview-text-cache";
import { EDIT_MODE_STRATEGIES } from "@veyyon/coding-agent/edit/streaming";
import { InMemorySnapshotStore } from "@veyyon/hashline";
import { removeWithRetries } from "@veyyon/utils";

/**
 * WHY: a streamed edit preview recomputes on every chunk the model emits, and
 * the replace mode's preview re-read the whole target file each time -- 46.8 MiB
 * of reads across two seconds of 30Hz args against an 11.7 MiB file, one read
 * per pass. The streaming pass now reads through a cache keyed by mtime+size;
 * the args-complete pass still reads fresh, because that is the text the edit
 * will actually be applied to.
 *
 * The class this closes is "a streamed preview pays for its target once per
 * chunk", so the suite pins both halves of the key (a same-size rewrite at the
 * same timestamp is served from the cache, a size change is not), the fact that
 * only the streaming pass consults it, that the strategy actually threads the
 * streaming flag through, and that the cache is bounded rather than growing a
 * whole file per path forever.
 *
 * Each row proves a cache hit by rewriting the file behind the cache and
 * restoring its timestamp: a served entry shows the stale text, a miss shows the
 * new text. A timestamp is pinned to whole seconds so the two stats compare
 * equal exactly.
 *
 * What it does not catch: a non-veyyon process that overwrites the file with a
 * same-length body inside the same timestamp tick is indistinguishable from no
 * change, which is the documented gap of an mtime+size key.
 */

const PINNED_MTIME = new Date(1_700_000_000_000);

let dir: string;

function writePinned(file: string, content: string): void {
	fs.writeFileSync(file, content);
	fs.utimesSync(file, PINNED_MTIME, PINNED_MTIME);
}

function diffOf(result: { diff: string } | { error: string }): string {
	if ("error" in result) throw new Error(`expected a diff, got: ${result.error}`);
	return result.diff;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-read-"));
	clearPreviewTextCache();
});

afterEach(async () => {
	await removeWithRetries(dir);
});

describe("a streamed preview reads its target once", () => {
	it("serves a streaming pass from the cache when mtime and size are unchanged", async () => {
		const file = path.join(dir, "a.ts");
		writePinned(file, "const before = 1;\nconst keep = 2;\n");

		const first = await computeEditDiff("a.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		expect(diffOf(first)).toContain("+2|const keep = 3;");

		// Same length, same timestamp: the only thing that changed is content
		// the cache cannot see.
		writePinned(file, "const after1 = 1;\nconst keep = 2;\n");
		const second = await computeEditDiff("a.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		expect(diffOf(second)).toContain("1|const before = 1;");
		expect(diffOf(second)).not.toContain("const after1 = 1;");
	});

	it("reads fresh when the pass is not streaming", async () => {
		const file = path.join(dir, "a.ts");
		writePinned(file, "const before = 1;\nconst keep = 2;\n");

		await computeEditDiff("a.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		writePinned(file, "const after1 = 1;\nconst keep = 2;\n");

		const final = await computeEditDiff("a.ts", "const keep = 2;", "const keep = 3;", dir, {});
		expect(diffOf(final)).toContain("1|const after1 = 1;");
	});

	it("re-reads when the size changed under an unchanged timestamp", async () => {
		const file = path.join(dir, "a.ts");
		writePinned(file, "const before = 1;\nconst keep = 2;\n");

		await computeEditDiff("a.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		writePinned(file, "const grown = 1;\nconst extra = 0;\nconst keep = 2;\n");

		const second = await computeEditDiff("a.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		expect(diffOf(second)).toContain("const extra = 0;");
	});

	it("re-reads when the timestamp moved at an unchanged size", async () => {
		const file = path.join(dir, "a.ts");
		writePinned(file, "const before = 1;\nconst keep = 2;\n");

		await computeEditDiff("a.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		fs.writeFileSync(file, "const after1 = 1;\nconst keep = 2;\n");
		const later = new Date(PINNED_MTIME.getTime() + 60_000);
		fs.utimesSync(file, later, later);

		const second = await computeEditDiff("a.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		expect(diffOf(second)).toContain("const after1 = 1;");
	});

	it("threads the streaming flag from the replace strategy", async () => {
		const file = path.join(dir, "a.ts");
		writePinned(file, "const before = 1;\nconst keep = 2;\n");
		const strategy = EDIT_MODE_STRATEGIES.replace;
		const args = { path: "a.ts", edits: [{ old_text: "const keep = 2;", new_text: "const keep = 3;" }] };
		const ctx = {
			cwd: dir,
			signal: new AbortController().signal,
			snapshots: new InMemorySnapshotStore(),
		};

		const streamed = await strategy.computeDiffPreview(args, { ...ctx, isStreaming: true });
		expect(streamed?.[0]?.diff).toContain("const before = 1;");

		writePinned(file, "const after1 = 1;\nconst keep = 2;\n");
		const stillStreaming = await strategy.computeDiffPreview(args, { ...ctx, isStreaming: true });
		expect(stillStreaming?.[0]?.diff).toContain("const before = 1;");

		const complete = await strategy.computeDiffPreview(args, { ...ctx, isStreaming: false });
		expect(complete?.[0]?.diff).toContain("const after1 = 1;");
	});

	it("bounds what it retains, evicting the oldest target", async () => {
		const paths: string[] = [];
		for (let i = 0; i < 9; i++) {
			const file = path.join(dir, `f${i}.ts`);
			writePinned(file, `const v${i} = 1;\nconst keep = 2;\n`);
			paths.push(file);
			await computeEditDiff(`f${i}.ts`, "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		}

		// Nine targets against an eight-entry cache: the first is gone, the last
		// is still held. Both are rewritten to the same length so only residency
		// separates them -- a length change would invalidate either entry.
		writePinned(paths[0], "const w0 = 1;\nconst keep = 2;\n");
		writePinned(paths[8], "const w8 = 1;\nconst keep = 2;\n");

		const evicted = await computeEditDiff("f0.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		expect(diffOf(evicted)).toContain("const w0 = 1;");

		const retained = await computeEditDiff("f8.ts", "const keep = 2;", "const keep = 3;", dir, { streaming: true });
		expect(diffOf(retained)).toContain("const v8 = 1;");
	});

	it("surfaces a missing target as an error on both passes", async () => {
		const absent = await computeEditDiff("gone.ts", "a", "b", dir, { streaming: true });
		expect("error" in absent).toBe(true);
		const fresh = await computeEditDiff("gone.ts", "a", "b", dir, {});
		expect("error" in fresh).toBe(true);
	});
});
