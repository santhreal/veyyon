// WHY: the unseen-line reveal in `patcher.ts` clipped a wide source line with
// `String.prototype.slice`, which counts UTF-16 code units. A clip landing
// between the two halves of an astral character (emoji, rare CJK) put a lone
// surrogate into the mismatch message: invalid text that renders as U+FFFD and
// reaches the model as a broken token. The same class was live in three
// coding-agent truncators, covered by the sibling suite there.
//
// The clip now routes through `truncate` from `@veyyon/utils`, which cuts by
// code point. This sweeps an astral character across every offset straddling
// SEEN_LINE_REVEAL_MAX_COLUMNS so the exact off-by-one that splits a pair
// cannot survive.
//
// It also pins the two properties the clip must not lose while being made
// safe: the revealed prefix is still budget columns wide plus the ellipsis,
// and `columnTruncated` is true exactly when the text really changed — that
// flag holds the merge gate closed, so a clip that stopped setting it would
// let the model piecewise-reveal its way past the guard.
//
// What this does NOT catch: a new clip site elsewhere in the package that
// hand-rolls a code-unit slice.

import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

const PATH = "a.ts";

/** SEEN_LINE_REVEAL_MAX_COLUMNS, mirrored from src/patcher.ts. */
const BUDGET = 512;

/** U+1F600, two UTF-16 code units. */
const ASTRAL = "\u{1F600}";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function filler(count: number): string {
	return "a".repeat(count);
}

/** Apply a patch that must fail, and return the mismatch message. */
async function messageFor(content: string, wideLine: string): Promise<string> {
	const fs = new InMemoryFilesystem([[PATH, content]]);
	const snapshots = new InMemorySnapshotStore();
	const tag = snapshots.record(PATH, content, [1]);
	const patcher = new Patcher({ fs, snapshots });
	try {
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 2.=3:\n+X\n+Y`));
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error(`expected a mismatch for a ${wideLine.length}-unit line`);
}

describe("a revealed line never splits an astral character", () => {
	it("keeps every astral character whole across the column boundary", async () => {
		for (const offset of [BUDGET - 3, BUDGET - 2, BUDGET - 1, BUDGET, BUDGET + 1]) {
			const wide = `${filler(offset)}${ASTRAL}${filler(BUDGET)}`;
			const message = await messageFor(`l1\n${wide}\nl3\nl4\n`, wide);
			expect({ offset, at: message.search(LONE_SURROGATE) }).toEqual({ offset, at: -1 });
		}
	});

	it("reveals exactly the budget in code points, then the ellipsis", async () => {
		// The astral character starts at code point BUDGET - 1, so it is the
		// last character that fits and must survive whole.
		const wide = `${filler(BUDGET - 1)}${ASTRAL}${filler(BUDGET)}`;
		const message = await messageFor(`l1\n${wide}\nl3\nl4\n`, wide);
		expect(message).toContain(`2:${filler(BUDGET - 1)}${ASTRAL}\u2026`);
		// The tail past the budget never leaks.
		expect(message).not.toContain(`${ASTRAL}${filler(1)}\u2026`.replace("\u2026", ""));
	});

	it("keeps the merge gate closed when a clipped line is re-read", async () => {
		// A clip must still mark the reveal truncated, or the model could reveal
		// wide lines piecewise and land a blind edit without a range re-read.
		const wide = `${filler(BUDGET)}${ASTRAL}${filler(BUDGET)}`;
		const content = `l1\n${wide}\nl3\nl4\n`;
		const fs = new InMemoryFilesystem([[PATH, content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, content, [1]);
		const patcher = new Patcher({ fs, snapshots });
		const patch = `[${PATH}#${tag}]\nSWAP 2.=3:\n+X\n+Y`;

		let first: string | undefined;
		try {
			await patcher.apply(Patch.parse(patch));
		} catch (err) {
			first = (err as Error).message;
		}
		// A retry of the identical patch is rejected again: the clipped reveal
		// never counted as "seen", so the guard stays armed.
		let second: string | undefined;
		try {
			await patcher.apply(Patch.parse(patch));
		} catch (err) {
			second = (err as Error).message;
		}
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(fs.get(PATH)).toBe(content);
	});

	it("leaves a wide-in-code-units but narrow-in-code-points line unclipped", async () => {
		// 300 astral characters = 600 code units but 300 code points, which fits
		// the 512-column budget: the line is revealed whole, with no ellipsis.
		const wide = ASTRAL.repeat(300);
		const message = await messageFor(`l1\n${wide}\nl3\nl4\n`, wide);
		expect(message).toContain(`2:${wide}`);
		expect(message).not.toContain(`${wide}\u2026`);
	});
});
