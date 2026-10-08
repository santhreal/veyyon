/**
 * A transcript block whose rows have gone to native scrollback keeps none of the rows it drew.
 *
 * THE DEFECT. The transcript container drops a block from its frame once the terminal's scrollback
 * holds its rows, but the block kept every row it had drawn: its own row memo, its Markdown's rows,
 * the frame its tool card built. A resumed session held a second copy of its whole transcript in the
 * heap for as long as it ran. Two siblings kept rows past the release as well: a user or developer
 * message built its Markdown prose style per message, which keyed the Markdown module's render cache
 * by an identity no other message shares, so every message's rows sat in that cache until it filled;
 * and a card drawn by the generic fallback kept its rail frame's rows in the table that pairs a frame
 * with the child it frames, whose child is a field the card never drops. And the container never
 * dropped the blocks of a resumed session at all: the engine's first paint draws every block, and a
 * block that reports a version became droppable only when a later frame drew it again at that
 * version. A session at rest draws nothing after its paint, and the frame that drops the committed
 * rows names no block, so the resumed transcript stayed whole in the engine's frame.
 *
 * THE CLASS. Any block kind that keeps a string it built from its rows after the release: a row memo,
 * a table keyed by the block's own identity, a frame kept beside a child that outlives the release.
 * The suite sweeps every message role the session vocabulary declares and every specialized custom
 * display the wire vocabulary declares, drawn through the transcript builder a resumed session uses
 * with its blocks collapsed and expanded (the fixture's samples are a `Record` over each union, so a
 * new role or display fails the type check until it has one, and a display sample that projects to
 * another variant fails the run); the read result preview setting, which adds a code cell under each
 * read; and every gallery tool's cards, listed from the gallery at run time, so
 * a new tool is measured with no change here. A tool whose gallery fixture draws no card is pinned by
 * exact equality below. Each group repeats its blocks until its first draw holds `TARGET_CHARS`
 * characters, so a group of one-row dividers is measured as closely as a group of tall cards, and a
 * block that keeps its rows keeps at least `TARGET_CHARS` bytes. Each group is also painted the way a
 * resumed session paints it, through the real engine on a terminal of `screenRows`, and the frame the
 * engine composes once the paint settles holds the screen, the screen kept for a shrink, and the
 * block the drop stops at.
 *
 * WHAT IT DOES NOT CATCH. A retention below `GROWTH_LIMIT` per group: a few bytes per block, such
 * as a key or a state tag, over a group of short blocks. A module cache bounded below
 * `GROWTH_LIMIT`. A block kind neither a role, a display, the preview setting nor a gallery tool
 * draws: a block still streaming, an extension's own component. A setting added later that draws a
 * block of its own, until the fixture lists it. The replay is compared by a hash of its rows at one
 * width. The resumed paint runs at one terminal size, and a block that reports itself live, which a
 * resumed session does not draw, is never dropped.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { availableParallelism } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
	CompactedBlockGroups,
	CompactedBlockGrowth,
	CompactedBlockReport,
} from "../../fixtures/compacted-block-string-growth";
import { hermeticSpawnEnv } from "../../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "..", "fixtures", "compacted-block-string-growth.ts");

/** Characters each group's first draw holds at least. */
const TARGET_CHARS = 64 * 1024;
/**
 * String bytes a group may leave live after its rows go to scrollback. A group that keeps its rows
 * keeps at least `TARGET_CHARS` bytes; the heap moves by up to about 10 KB between two snapshots of
 * a group that keeps none.
 */
const GROWTH_LIMIT = 24 * 1024;
/** Fresh processes measuring at once. Each holds a full terminal and snapshots its heap. */
const SHARDS = Math.max(1, Math.min(8, availableParallelism()));
const SUITE_TIMEOUT_MS = 300_000;

async function fixture(args: string[]): Promise<string> {
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const { stdout, stderr } = await run(process.execPath, [FIXTURE, ...args], {
			env,
			maxBuffer: 16 * 1024 * 1024,
			timeout: SUITE_TIMEOUT_MS - 10_000,
			killSignal: "SIGKILL",
		});
		expect(stderr).toBe("");
		return stdout;
	} finally {
		cleanup();
	}
}

async function measure(groups: readonly string[]): Promise<CompactedBlockGrowth[]> {
	const report = JSON.parse(await fixture([String(TARGET_CHARS), groups.join(",")])) as CompactedBlockReport;
	return report.groups;
}

/**
 * Every group, measured. A process measures its shard in sequence, so a group's reading can carry
 * what the group before it left behind; a group over the limit is measured again alone, in a process
 * of its own, and that reading is the one kept. A block that keeps its rows keeps them in both.
 */
async function measureAll(groups: readonly string[]): Promise<CompactedBlockGrowth[]> {
	const shards: string[][] = Array.from({ length: Math.min(SHARDS, groups.length) }, () => []);
	for (let index = 0; index < groups.length; index++) shards[index % shards.length]!.push(groups[index]!);
	const measured = (await Promise.all(shards.map(shard => measure(shard)))).flat();
	return Promise.all(
		measured.map(async result =>
			result.grown < GROWTH_LIMIT ? result : ((await measure([result.group]))[0] ?? result),
		),
	);
}

describe("a transcript block whose rows went to native scrollback", () => {
	it(
		"keeps none of the rows it drew, and draws them again when replayed",
		async () => {
			const listing = JSON.parse(await fixture(["list"])) as CompactedBlockGroups;
			// The read group is drawn by the transcript builder from a read tool result, which the
			// `toolResult` role holds; its gallery fixture draws a group rather than a card.
			expect(listing.cardless).toEqual(["read_group"]);
			expect(listing.groups).toContain("user");
			expect(listing.groups).toContain("display:advisor");
			expect(listing.groups).toContain("toolResult:preview:expanded");
			expect(listing.groups.filter(group => group.startsWith("card:")).length).toBeGreaterThan(0);

			const results = await measureAll(listing.groups);
			expect(results.map(result => result.group).sort()).toEqual([...listing.groups].sort());
			for (const group of ["toolResult", "toolResult:preview"]) {
				expect(results.find(result => result.group === group)?.kinds).toContain("ReadToolGroupComponent");
			}
			// Each group drew what it was sized to, so a clean reading is not a group that drew nothing.
			expect(results.filter(result => result.rowChars < TARGET_CHARS).map(result => result.group)).toEqual([]);

			expect(results.filter(result => result.keptRows !== 0).map(result => result.group)).toEqual([]);
			expect(
				results
					.filter(result => result.grown >= GROWTH_LIMIT)
					.map(result => ({ group: result.group, blocks: result.blocks, grown: result.grown })),
			).toEqual([]);
			expect(results.filter(result => !result.replayMatches).map(result => result.group)).toEqual([]);

			// The resumed paint keeps the screen, the screen kept for a shrink, and the block the drop
			// stops at behind its separator. A group whose paint fits that bound proves nothing.
			const framedBound = (result: CompactedBlockGrowth) => 2 * result.screenRows + result.tallestRows + 1;
			expect(
				results.filter(result => result.paintedRows <= framedBound(result)).map(result => result.group),
			).toEqual([]);
			expect(
				results
					.filter(result => result.framedRows > framedBound(result))
					.map(result => ({ group: result.group, framedRows: result.framedRows, bound: framedBound(result) })),
			).toEqual([]);
		},
		SUITE_TIMEOUT_MS,
	);
});
