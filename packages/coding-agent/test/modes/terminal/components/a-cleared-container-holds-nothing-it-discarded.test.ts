/**
 * WHY: a transcript rebuild (resume, theme change, thinking toggle, collab resync) clears the
 * transcript container and builds the whole tree again before the next frame. `clear()` retired
 * the old frame by generation but kept `#segments` (every discarded block, its raw rows and its
 * contribution) and `#lines` (every assembled row), so the old tree and the new one were both live
 * at the rebuild's peak; the base `Container` kept its children's last row arrays the same way.
 *
 * Class closed: any `Container` subclass exported by `@veyyon/tui` or the transcript container
 * module whose `clear()` leaves a reference to a discarded child, a row array a discarded child
 * returned, or the frame the container last returned. The sweep enumerates the exports at run time,
 * so a new subclass is exercised or must be added to the pinned opt-out list. Each member is driven
 * through every frame path that fills retained state: a full frame, a resize, and for the transcript
 * container a committed-prefix compaction, a component-scoped frame and a scoped set still pending.
 *
 * Not caught: a `Container` subclass defined outside those two modules that adds its own per-child
 * cache, and retention of strings (which cannot be `WeakRef` targets) held outside any array.
 */
import { describe, expect, it } from "bun:test";
import * as transcriptModule from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import * as tuiModule from "@veyyon/tui";
import { type Component, Container } from "@veyyon/tui";

type ContainerClass = new () => Container;

/** The engine root: never cleared in production, and its frame segments are the previous frame the next emit diffs against. */
const OPTED_OUT = ["TUI"];

function isContainerClass(value: unknown): value is ContainerClass {
	return typeof value === "function" && (value === Container || value.prototype instanceof Container);
}

function containerClasses(): Map<string, ContainerClass> {
	const found = new Map<string, ContainerClass>();
	for (const mod of [tuiModule, transcriptModule]) {
		for (const [name, value] of Object.entries(mod)) {
			if (isContainerClass(value)) found.set(name, value);
		}
	}
	return found;
}

/** A child that records a weak reference to itself and to every row array it returns. */
class ProbeBlock implements Component {
	constructor(
		readonly id: number,
		readonly arrays: WeakRef<object>[],
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const rows = [`block ${this.id} at ${width}`, `body ${this.id}`];
		this.arrays.push(new WeakRef(rows));
		return rows;
	}
}

interface Discarded {
	children: WeakRef<object>[];
	arrays: WeakRef<object>[];
	frames: WeakRef<object>[];
}

const BLOCKS = 12;

/**
 * Fill `container`, drive it through `frames`, then clear it. Runs in its own frame so none of the
 * strong references it creates survive on the caller's stack.
 */
function fillAndClear<T extends Container>(container: T, frames: (container: T) => (readonly string[])[]): Discarded {
	const discarded: Discarded = { children: [], arrays: [], frames: [] };
	for (let i = 0; i < BLOCKS; i++) {
		const block = new ProbeBlock(i, discarded.arrays);
		container.addChild(block);
		discarded.children.push(new WeakRef(block));
	}
	for (const frame of frames(container)) discarded.frames.push(new WeakRef(frame));
	container.clear();
	return discarded;
}

async function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

function alive(refs: WeakRef<object>[]): number {
	let count = 0;
	for (const ref of refs) if (ref.deref() !== undefined) count++;
	return count;
}

/**
 * Collect until nothing in `discarded` is reachable, at most `limit` times. A `WeakRef` target stays
 * alive until the job that created or read it ends, so each collection runs on a new turn. JSC scans
 * the native stack conservatively: a stale pointer left in a reused stack slot can keep one or two
 * objects alive for a few turns, and new turns overwrite it. A retention by the container never
 * clears, so the bound only ends the wait.
 */
const MAX_COLLECTIONS = 16;
async function collect(
	discarded: Discarded,
	limit = MAX_COLLECTIONS,
): Promise<{ children: number; arrays: number; frames: number }> {
	let counts = { children: 0, arrays: 0, frames: 0 };
	for (let attempt = 0; attempt < limit; attempt++) {
		await nextTurn();
		Bun.gc(true);
		counts = {
			children: alive(discarded.children),
			arrays: alive(discarded.arrays),
			frames: alive(discarded.frames),
		};
		if (counts.children + counts.arrays + counts.frames === 0) break;
	}
	return counts;
}

const NOTHING = { children: 0, arrays: 0, frames: 0 };

describe("a cleared container holds nothing it discarded", () => {
	it("sweeps every exported Container subclass, opting out only the engine root", () => {
		const classes = containerClasses();
		const optedOut = [...classes.keys()].filter(name => OPTED_OUT.includes(name));
		expect(optedOut).toEqual(OPTED_OUT);
		const unconstructable: string[] = [];
		for (const [name, cls] of classes) {
			if (OPTED_OUT.includes(name)) continue;
			try {
				new cls();
			} catch {
				unconstructable.push(name);
			}
		}
		expect(unconstructable).toEqual([]);
	});

	for (const [name, cls] of containerClasses()) {
		if (OPTED_OUT.includes(name)) continue;
		it(`${name}: a full frame and a resize`, async () => {
			const container = new cls();
			const discarded = fillAndClear(container, c => [c.render(80), c.render(60)]);
			expect(await collect(discarded)).toEqual(NOTHING);
			// The container itself stays reachable, as a transcript container does across a rebuild.
			expect(container.children).toEqual([]);
		});
	}

	it("TranscriptContainer: a committed prefix compacted out of the frame", async () => {
		const container = new TranscriptContainer();
		const discarded = fillAndClear(container, c => {
			const first = c.render(80);
			c.setNativeScrollbackCommittedRows(first.length);
			return [first, c.render(80)];
		});
		expect(await collect(discarded)).toEqual(NOTHING);
		expect(container.children).toEqual([]);
	});

	it("TranscriptContainer: a component-scoped frame", async () => {
		const container = new TranscriptContainer();
		const discarded = fillAndClear(container, c => {
			const first = c.render(80);
			c.setComponentScopedRenderChildren(new Set([c.children[BLOCKS - 2]!]));
			return [first, c.render(80)];
		});
		expect(await collect(discarded)).toEqual(NOTHING);
		expect(container.children).toEqual([]);
	});

	it("TranscriptContainer: a scoped set named after the last frame", async () => {
		const container = new TranscriptContainer();
		const discarded = fillAndClear(container, c => {
			const first = c.render(80);
			c.setComponentScopedRenderChildren(new Set(c.children));
			return [first];
		});
		expect(await collect(discarded)).toEqual(NOTHING);
		expect(container.children).toEqual([]);
	});

	it("a container that keeps its children keeps them reachable", async () => {
		const container = new TranscriptContainer();
		const kept: Discarded = { children: [], arrays: [], frames: [] };
		for (let i = 0; i < BLOCKS; i++) {
			const block = new ProbeBlock(i, kept.arrays);
			container.addChild(block);
			kept.children.push(new WeakRef(block));
		}
		container.render(80);
		expect(await collect(kept, 2)).toEqual({ children: BLOCKS, arrays: BLOCKS, frames: 0 });
		expect(container.children).toHaveLength(BLOCKS);
	});
});
