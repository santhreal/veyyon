/**
 * The transcript reports exactly the leading rows that did not change.
 *
 * The engine re-reads every row at or after the transcript's stable-prefix
 * report: it truncates the composed frame there, strips cursor markers row by
 * row and drops its prepared-row cache from that index. The report decided
 * stability per block, so a block that re-rendered (a streaming reply growing
 * at its tail) counted none of its rows stable, and every frame of a long reply
 * re-read the whole reply although only its last rows changed.
 *
 * Class: any frame whose report differs from the common prefix of the rows the
 * engine last read and the rows the transcript now returns. Lower than the
 * common prefix re-reads unchanged rows (the per-frame cost above); higher
 * leaves a changed row unread and the screen stale. The suite asserts equality
 * at the choke point every frame passes through, `getRenderStablePrefixRows()`,
 * over a seeded walk of every edit a block can make (grow, edit, shrink, empty,
 * blank edges, add, remove, invalidate), on blocks that return a fresh array
 * per render and blocks that return the same array until they change, on full
 * and component-scoped frames, and with renders the engine never read in
 * between. Every frame's rows are also checked against an assembly computed
 * without the transcript, since a stable path that kept a stale row reports a
 * prefix that agrees with its own wrong output. A streamed reply from the
 * production assistant component is held to the same equality.
 *
 * Not caught: a width change, which reports 0 by design (every block re-wraps,
 * pinned in transcript-container.test.ts), and frames that drop committed rows
 * out of the front of the transcript, whose shift the engine reads separately.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { Component } from "@veyyon/tui";
import type { AssistantMessageView } from "@veyyon/wire/presentation";

const WIDTH = 60;

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

/**
 * A block whose rows the walk edits. A fresh block returns a new array every
 * render, as most components do; a held block returns the same array until it
 * changes, which is what lets the transcript reuse its rows without reading them.
 * A live block is still mutating; a finished one reports each later edit through
 * its version, as the transcript's block protocol requires of a finalized block.
 */
class EditableBlock implements Component {
	#rows: string[];
	#held: readonly string[] | undefined;
	#version = 0;
	readonly fresh: boolean;
	readonly live: boolean;

	constructor(rows: string[], fresh: boolean, live: boolean) {
		this.#rows = rows;
		this.fresh = fresh;
		this.live = live;
	}

	get rows(): readonly string[] {
		return this.#rows;
	}

	set(rows: string[]): void {
		this.#rows = rows;
		this.#held = undefined;
		this.#version++;
	}

	isTranscriptBlockFinalized(): boolean {
		return !this.live;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	invalidate(): void {
		this.#held = undefined;
	}

	render(_width: number): readonly string[] {
		if (this.fresh) return [...this.#rows];
		this.#held ??= [...this.#rows];
		return this.#held;
	}
}

/** Deterministic PRNG (mulberry32): one seed, one walk, on every run. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a[i] === b[i]) i++;
	return i;
}

const PLAIN_BLANK = /^\s*$/;

/**
 * The rows the transcript must return, assembled without it: each block's rows
 * with plain-blank edges dropped, visible blocks one blank row apart. A report
 * is only as good as the rows it describes; a stable path that kept a stale row
 * would still agree with itself.
 */
function assembled(blocks: readonly EditableBlock[]): string[] {
	const frame: string[] = [];
	for (const block of blocks) {
		const rows = block.rows;
		let start = 0;
		let end = rows.length;
		while (start < end && PLAIN_BLANK.test(rows[start]!)) start++;
		while (end > start && PLAIN_BLANK.test(rows[end - 1]!)) end--;
		if (start === end) continue;
		if (frame.length > 0) frame.push("");
		for (let i = start; i < end; i++) frame.push(rows[i]!);
	}
	return frame;
}

/**
 * Rows drawn from a small alphabet that includes plain blanks, so edits often
 * leave a row equal to the one it replaced, a block's edges strip, and a
 * separator row lines up with a body row that used to sit there.
 */
const ALPHABET = ["alpha", "beta", "gamma", "", "  ", "delta"];

type Edit = "grow" | "edit" | "shrink" | "empty" | "blank-edges" | "add" | "remove" | "invalidate";
const EDITS: readonly Edit[] = ["grow", "edit", "shrink", "empty", "blank-edges", "add", "remove", "invalidate"];

describe("a re-rendered block keeps its unchanged rows stable", () => {
	it("returns the assembled rows and reports their common prefix with the last read rows on every frame", () => {
		const random = prng(0x5eed);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
		const row = () => pick(ALPHABET);
		const rows = (count: number) => Array.from({ length: count }, row);

		const container = new TranscriptContainer();
		const blocks: EditableBlock[] = [];
		const addBlock = () => {
			const block = new EditableBlock(rows(1 + Math.floor(random() * 4)), random() < 0.5, random() < 0.3);
			blocks.push(block);
			container.addChild(block);
		};
		for (let i = 0; i < 4; i++) addBlock();

		let lastRead = [...container.render(WIDTH)];
		container.getRenderStablePrefixRows();
		const applied = new Map<Edit, number>();
		let scopedFrames = 0;
		let unreadRenders = 0;
		let midBlockReports = 0;

		for (let step = 0; step < 4000; step++) {
			const edit = pick(EDITS);
			let named: EditableBlock | undefined;
			if (edit === "add" || blocks.length === 0) {
				addBlock();
			} else if (edit === "remove") {
				const index = Math.floor(random() * blocks.length);
				container.removeChild(blocks[index]!);
				blocks.splice(index, 1);
			} else {
				const block = pick(blocks);
				named = block;
				const current = block.rows;
				if (edit === "grow") block.set([...current, row()]);
				else if (edit === "edit" && current.length > 0) {
					const at = Math.floor(random() * current.length);
					block.set(current.map((value, i) => (i === at ? row() : value)));
				} else if (edit === "shrink") block.set(current.slice(0, -1));
				else if (edit === "empty") block.set([]);
				else if (edit === "blank-edges") block.set(["", ...rows(2), "  "]);
				else if (edit === "invalidate") container.invalidate();
				else block.set(rows(1));
			}
			applied.set(edit, (applied.get(edit) ?? 0) + 1);

			// A frame that names only the edited block re-derives from it and
			// reuses every row above; an add or remove forces a full walk anyway.
			if (named !== undefined && random() < 0.4) {
				container.setComponentScopedRenderChildren(new Set([named]));
				scopedFrames++;
			}
			let current = [...container.render(WIDTH)];
			let expected = commonPrefix(lastRead, current);
			// A render the engine does not read (an exporter walking the tree)
			// can only lower the next report.
			if (random() < 0.2) {
				const between = current;
				current = [...container.render(WIDTH)];
				expected = Math.min(expected, commonPrefix(between, current));
				unreadRenders++;
			}

			const report = container.getRenderStablePrefixRows();
			const want = assembled(blocks);
			if (report !== expected || commonPrefix(current, want) !== Math.max(current.length, want.length)) {
				throw new Error(
					`step ${step} (${edit}): reported ${report}, rows agree through ${expected}\nlast read: ${JSON.stringify(lastRead)}\ncurrent:   ${JSON.stringify(current)}\nassembled: ${JSON.stringify(want)}`,
				);
			}
			if (report > 0 && report < current.length && current[report - 1] !== "" && current[report] !== "") {
				midBlockReports++;
			}
			lastRead = current;
		}

		// Every edit, the scoped and unread-render paths, and reports that land
		// inside a block's body all occurred, so the equality above covered them.
		expect(EDITS.filter(edit => !applied.has(edit))).toEqual([]);
		expect(scopedFrames).toBeGreaterThan(0);
		expect(unreadRenders).toBeGreaterThan(0);
		expect(midBlockReports).toBeGreaterThan(0);
	});

	it("reports every row above a streamed reply's changed tail", () => {
		const container = new TranscriptContainer();
		const reply = new AssistantMessageComponent();
		container.addChild(reply);

		const paragraph = (n: number) =>
			`${Array.from({ length: 30 }, (_, w) => `word${n}-${w}`).join(" ")} ending paragraph ${n}.`;
		const full = Array.from({ length: 12 }, (_, n) => paragraph(n)).join("\n\n");

		let lastRead: string[] = [];
		let reread = 0;
		let total = 0;
		for (let end = 40; end <= full.length; end += 40) {
			reply.updateContent(assistantText(full.slice(0, end)));
			const current = [...container.render(WIDTH)];
			const report = container.getRenderStablePrefixRows();
			expect(report).toBe(commonPrefix(lastRead, current));
			reread += current.length - report;
			total += current.length;
			lastRead = current;
		}

		// A delta rewrites the reply's last rows and leaves the rest. Re-reading
		// the whole reply each frame re-reads every row of every frame.
		expect(reread * 10).toBeLessThan(total);
	});
});

/** A reply's text as the stream carries it from one delta to the next. */
function assistantText(text: string): AssistantMessageView {
	return {
		segments: [{ kind: "text", text }],
		model: "claude-sonnet-4-5",
		stopReason: "complete",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		timestamp: 0,
	};
}
