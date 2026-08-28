import {
	type Component,
	Container,
	clampLow,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackCompaction,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackReplay,
	type RenderStablePrefix,
	type ViewportTailProvider,
} from "@veyyon/tui";

/** A transcript block that is still mutating (a foreground tool awaiting its result, an assistant message mid-stream) reports `false` so the container */
interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	/** Monotonic content version for blocks that can still mutate *after* reporting finalized (e.g. `AssistantMessageComponent`: the inline error */
	getTranscriptBlockVersion?(): number;
	/** Leading rows of the block's current render() output that are declared FINAL while the block is still live: byte-stable at the current width */
	getTranscriptBlockSettledRows?(): number;
	/** Whether the block is a displaceable snapshot (todo/poll card) kept unfinalized only so a follow-up matching call can retract it. Paired */
	isDisplaceableBlock?(): boolean;
	/** Finalize a displaceable snapshot in place (settle animation, freeze bytes). */
	seal?(): void;
}

function isBlockFinalized(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockFinalized;
	return fn ? fn.call(child) : true;
}

function getBlockVersion(child: Component): number | undefined {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockVersion;
	return fn ? fn.call(child) : undefined;
}

/** Clamped read of a block's declared settled rows (see {@link FinalizableBlock}). */
function getBlockSettledRows(child: Component): number {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockSettledRows;
	if (!fn) return 0;
	const value = fn.call(child);
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Seal a displaceable snapshot whose rows entered native scrollback (see {@link FinalizableBlock.isDisplaceableBlock}). */
function sealCommittedSnapshot(child: Component): void {
	const block = child as Component & FinalizableBlock;
	if (block.isDisplaceableBlock?.()) block.seal?.();
}

// A "plain blank" row is empty or whitespace-only with no ANSI bytes. It marks separation padding (a `Spacer`, or a no-background `paddingY` row) as opposed
const NON_WHITESPACE = /\S/;
function isPlainBlank(line: string): boolean {
	return !NON_WHITESPACE.test(line);
}

// Strip leading/trailing plain-blank rows so each block contributes only its
// visible body; the container owns the gaps between blocks. Returns the input
// array unchanged when there is nothing to trim (no allocation on the hot path).
function stripPlainBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isPlainBlank(lines[start]!)) start++;
	while (end > start && isPlainBlank(lines[end - 1]!)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

/** One block's recorded contribution to the assembled transcript: the raw array reference its render() returned, the stripped contribution derived from it, */
interface BlockSegment {
	component: Component;
	rawRef: readonly string[];
	contribution: readonly string[];
	width: number;
	generation: number;
	/** Frame row of this block's first emitted row (the separator when present). */
	startRow: number;
	/** Rows emitted: separator + contribution (0 for empty contributions). */
	rowCount: number;
	sep: number;
	/** Whether the block reported finalized when this segment was rendered. */
	finalized: boolean;
	/** Safe to drop after commit: produced while finalized, without post-finalize version tracking. */
	compactable: boolean;
	/** Block version observed when this segment was rendered (see {@link FinalizableBlock}). */
	version: number | undefined;
}

const EMPTY_SEGMENTS: BlockSegment[] = [];
/** Shared empty result for an empty viewport-tail render (no allocation). */
const EMPTY_TAIL: readonly string[] = [];

/** Transcript container that renders every block's current content each frame and reports the native-scrollback exactness boundary */
export class TranscriptContainer
	extends Container
	implements
		NativeScrollbackLiveRegion,
		NativeScrollbackCommittedRows,
		NativeScrollbackCompaction,
		NativeScrollbackReplay,
		RenderStablePrefix,
		ViewportTailProvider
{
	// Bumped to retire every block segment at once (theme change / clear); a
	// segment is only reused when its stored generation matches.
	#generation = 0;
	// Local line index below which every row of the most recent render is
	// final: the leading finalized blocks plus the first live block's declared
	// settled rows. TUI commits rows to native scrollback only above it.
	#nativeScrollbackLiveRegionStart: number | undefined;
	// Persistent assembled transcript rows. Rows before the stable floor are
	// byte-identical to the previous render; rows at/after it were re-pushed.
	#lines: string[] = [];
	#segments: BlockSegment[] = EMPTY_SEGMENTS;
	#renderWidth = -1;
	// Local rows already committed to native scrollback by the previous frame.
	// Finalized blocks wholly before this boundary are immutable on-screen history;
	// their previous contribution can be replayed without calling render().
	#committedRows = 0;
	// Leading children whose rows were handed to native scrollback and dropped
	// from the local frame. Children remain owned by the session and can be
	// re-rendered when the TUI prepares a destructive full replay.
	#compactedChildStart = 0;
	// Suppresses re-compaction for the rehydrating render. The TUI feeds its old
	// committed-row count immediately before render, so resetting that count
	// alone cannot distinguish a replay from an ordinary update.
	#replayPending = false;
	// Rows dropped out of the front of #lines since the engine last read the
	// count. The engine slides its commit index by exactly this much.
	#droppedRows = 0;
	// Committed rows the frame must keep so the engine can re-show them when a
	// frame shrinks below the viewport. Fed by the engine every render; zero
	// until it is (a container nobody drives compacts as before).
	#retainRows = 0;
	// Stable-prefix floor accumulated across renders since the last getRenderStablePrefixRows() read (see RenderStablePrefix: reading
	#stableRowsFloor = 0;
	override invalidate(): void {
		// Theme/global invalidation: retire every diff snapshot so stale styling
		// is not diffed against the recolored render.
		this.#generation++;
		super.invalidate();
	}

	override clear(): void {
		this.#generation++;
		super.clear();
		this.#compactedChildStart = 0;
		this.#droppedRows = 0;
		this.#replayPending = false;
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
	}

	prepareNativeScrollbackReplay(): void {
		if (this.#compactedChildStart === 0) return;
		this.#compactedChildStart = 0;
		this.#replayPending = true;
		this.#generation++;
		this.#lines.length = 0;
		this.#stableRowsFloor = 0;
		// The replay re-renders the whole transcript, so the rows dropped so far
		// come back in the same frame. Reporting them would slide the engine's
		// commit index down against a frame that just grew.
		this.#droppedRows = 0;
	}

	/** A viewport's worth of committed rows the frame keeps rather than dropping (see NativeScrollbackCompaction). Compaction exists so old blocks are not */
	setNativeScrollbackRetainRows(rows: number): void {
		this.#retainRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
	}

	/** Rows dropped out of the front of the frame since the last read, so the engine can move its commit index with them (see NativeScrollbackCompaction). */
	takeNativeScrollbackDroppedRows(): number {
		const rows = this.#droppedRows;
		this.#droppedRows = 0;
		return rows;
	}

	getRenderStablePrefixRows(): number {
		const value = Math.min(this.#stableRowsFloor, this.#lines.length);
		this.#stableRowsFloor = this.#lines.length;
		return value;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#nativeScrollbackLiveRegionStart;
	}

	/** Whether none of `component`'s rows (per the most recent render) have entered native scrollback. Callers that retract ephemeral blocks (IRC */
	isBlockUncommitted(component: Component): boolean {
		const index = this.children.indexOf(component);
		// Compacted prefix is already committed native history and must not be retracted. Compacted slots may be sparse holes after a later re-render
		if (index >= 0 && index < this.#compactedChildStart) return false;
		for (let si = 0; si < this.#segments.length; si++) {
			const segment = this.#segments[si];
			if (segment === undefined || segment.component !== component) continue;
			return segment.rowCount === 0 || segment.startRow >= this.#committedRows;
		}
		return true;
	}

	/** Whether `component` is inside the live (repaintable) region exactly as {@link render} computes it: at/after the first still-mutating block, or */
	isBlockInLiveRegion(component: Component): boolean {
		const children = this.children;
		const index = children.indexOf(component);
		if (index < 0) return false;
		for (let i = 0; i <= index; i++) {
			if (!isBlockFinalized(children[i]!)) return true;
		}
		// Every block at/before `index` finalized: the live region starts at the
		// first unfinalized block below it, or at the last child when none exists.
		for (let i = index + 1; i < children.length; i++) {
			if (!isBlockFinalized(children[i]!)) return false;
		}
		return index === children.length - 1;
	}

	/** Render only the bottom `maxRows` rows of the transcript at `width`, walking blocks from the last toward the first and stopping the instant enough rows */
	renderViewportTail(width: number, maxRows: number): readonly string[] {
		width = Math.max(1, width);
		if (maxRows <= 0) return EMPTY_TAIL;
		const collected: (readonly string[])[] = [];
		let total = 0;
		for (let i = this.children.length - 1; i >= this.#compactedChildStart && total < maxRows; i--) {
			const contribution = stripPlainBlankEdges(this.children[i]!.render(width));
			if (contribution.length === 0) continue;
			// One blank separator sits between this block and the (already
			// collected) visible block below it.
			if (collected.length > 0) total += 1;
			collected.push(contribution);
			total += contribution.length;
		}
		if (collected.length === 0) return EMPTY_TAIL;
		const rows: string[] = [];
		for (let k = collected.length - 1; k >= 0; k--) {
			if (rows.length > 0) rows.push("");
			const body = collected[k]!;
			for (let j = 0; j < body.length; j++) rows.push(body[j]!);
		}
		return rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows;
	}

	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;

		const count = this.children.length;
		if (this.#compactedChildStart > count) this.#compactedChildStart = count;

		// Seal displaceable snapshots whose rows are already on the tape (per the previous frame's segments — the geometry the committed count was
		for (let i = this.#compactedChildStart; i < count && i < this.#segments.length; i++) {
			const previous = this.#segments[i];
			if (previous === undefined) continue;
			if (previous.startRow >= this.#committedRows) break;
			if (previous.rowCount === 0 || previous.component !== this.children[i]) continue;
			sealCommittedSnapshot(previous.component);
		}

		// The commit boundary stops at the earliest still-mutating block. A block that has not finalized must gate it: out-of-band inserts
		let liveStartIndex = -1;
		let hasLiveBlock = false;
		for (let i = this.#compactedChildStart; i < count; i++) {
			if (!isBlockFinalized(this.children[i]!)) {
				liveStartIndex = i;
				hasLiveBlock = true;
				break;
			}
		}

		const lines = this.#lines;
		const previousSegments = this.#segments;
		const segments: BlockSegment[] = new Array(count);
		// Poisoned until the walk completes: a block render throwing mid-walk
		// leaves the persistent array half-rebuilt, and the next render must
		// not trust stale segments against it. Restored at the end.
		this.#segments = EMPTY_SEGMENTS;
		const stableFloorBefore = this.#stableRowsFloor;
		this.#stableRowsFloor = 0;
		// Stability requires the same width and, per segment, the same block at the same offset returning the same array reference. The first
		let chainStable = this.#renderWidth === width;
		this.#renderWidth = width;
		// Entry-unstable (width change): the divergence truncation inside the loop only fires on a stable→unstable transition, so reset the
		if (!chainStable) lines.length = 0;

		// Frame row cursor: rows emitted (reused or pushed) so far.
		let row = 0;
		let stableRows = 0;
		for (let i = this.#compactedChildStart; i < count; i++) {
			const child = this.children[i]!;

			// This child's contribution: its current render with plain-blank top/bottom edges stripped (the container owns inter-block gaps).
			const previous = previousSegments[i];
			const finalized = isBlockFinalized(child);
			const version = getBlockVersion(child);
			const committedReusable =
				previous !== undefined &&
				previous.component === child &&
				previous.width === width &&
				previous.generation === this.#generation &&
				previous.startRow === row &&
				previous.startRow + previous.rowCount <= this.#committedRows &&
				finalized &&
				// Only replay bytes that were themselves produced by a finalized render: a block finalizing between frames may have changed content
				previous.finalized &&
				// Post-finalize mutations (inline error restore, late tool images)
				// bump the block version; a mismatch forces a real render so the
				// committed-prefix audit can observe and re-anchor the change.
				previous.version === version;
			const raw = committedReusable ? previous.rawRef : child.render(width);
			const reusable =
				committedReusable ||
				(previous !== undefined &&
					previous.component === child &&
					previous.rawRef === raw &&
					previous.width === width &&
					previous.generation === this.#generation);
			const contribution = reusable ? previous.contribution : stripPlainBlankEdges(raw);
			const compactable = finalized && version === undefined && previous?.finalized !== false;

			// Empty (or stripped-to-nothing) children contribute nothing and never affect spacing. An empty still-live child still gates the commit
			if (contribution.length === 0) {
				if (hasLiveBlock && i === liveStartIndex) {
					this.#nativeScrollbackLiveRegionStart = row;
				}
				if (chainStable && !(reusable && previous.rowCount === 0 && previous.startRow === row)) {
					chainStable = false;
					lines.length = row;
				}
				if (chainStable) stableRows = row;
				segments[i] = {
					component: child,
					rawRef: raw,
					contribution,
					width,
					generation: this.#generation,
					startRow: row,
					rowCount: 0,
					sep: 0,
					finalized,
					compactable,
					version,
				};
				continue;
			}

			// Every block is separated from preceding visible content by exactly one blank row — skipped when it opens the transcript or the prior row is
			const sep = row > 0 && !isPlainBlank(lines[row - 1]!) ? 1 : 0;

			// The separator before the first live block stays in the committed prefix (it is deterministic once the prior block's body is
			if (hasLiveBlock && i === liveStartIndex) {
				let settled = 0;
				const settledRaw = getBlockSettledRows(child);
				if (settledRaw > 0) {
					let lead = 0;
					while (lead < raw.length && isPlainBlank(raw[lead]!)) lead++;
					settled = clampLow(settledRaw - lead, 0, contribution.length);
				}
				this.#nativeScrollbackLiveRegionStart = row + sep + settled;
			}

			const rowCount = sep + contribution.length;
			const stable = chainStable && reusable && previous.startRow === row && previous.sep === sep;
			if (stable) {
				stableRows = row + rowCount;
			} else {
				if (chainStable) {
					chainStable = false;
					lines.length = row;
				}
				if (sep) lines.push("");
				for (let j = 0; j < contribution.length; j++) lines.push(contribution[j]!);
			}

			segments[i] = {
				component: child,
				rawRef: raw,
				contribution,
				width,
				generation: this.#generation,
				startRow: row,
				rowCount,
				sep,
				finalized,
				compactable,
				version,
			};
			row += rowCount;
		}
		// Trailing shrink: blocks removed from the tail leave stale rows behind
		// when every surviving segment was reused.
		if (lines.length !== row) lines.length = row;
		this.#segments = segments;
		this.#stableRowsFloor = Math.min(stableFloorBefore, stableRows, row);
		if (this.#replayPending) {
			this.#replayPending = false;
		} else {
			this.#compactCommittedPrefix();
		}
		return lines;
	}

	#compactCommittedPrefix(): void {
		if (this.#committedRows <= 0 || this.#compactedChildStart >= this.children.length) return;
		// Committed rows above this are droppable; the rest is the screen's worth the engine keeps in hand for a shrink. The ceiling bounds the drop only —
		const dropCeiling = Math.max(0, this.#committedRows - this.#retainRows);
		if (dropCeiling <= 0) return;
		const lines = this.#lines;
		const segments = this.#segments;
		let dropRows = 0;
		let dropUntil = this.#compactedChildStart;
		for (let i = this.#compactedChildStart; i < segments.length; i++) {
			const segment = segments[i];
			if (segment === undefined || !segment.compactable) break;
			const segmentEnd = segment.startRow + segment.rowCount;
			if (segmentEnd > dropCeiling) break;
			dropRows = segmentEnd;
			dropUntil = i + 1;
		}
		const retained = segments[dropUntil];
		if (retained !== undefined && retained.sep > 0) {
			const committedSeparatorRows = dropCeiling - retained.startRow;
			if (committedSeparatorRows <= 0) {
				dropRows = 0;
				dropUntil = this.#compactedChildStart;
			} else {
				const trim = Math.min(retained.sep, committedSeparatorRows);
				dropRows += trim;
				retained.sep -= trim;
				retained.rowCount -= trim;
			}
		}
		if (dropRows === 0) return;

		lines.splice(0, dropRows);
		this.#droppedRows += dropRows;
		for (let i = this.#compactedChildStart; i < dropUntil; i++) {
			const segment = segments[i];
			if (segment === undefined) continue;
			segments[i] = {
				component: segment.component,
				rawRef: EMPTY_TAIL,
				contribution: EMPTY_TAIL,
				width: segment.width,
				generation: segment.generation,
				startRow: 0,
				rowCount: 0,
				sep: 0,
				finalized: true,
				compactable: false,
				version: segment.version,
			};
		}
		for (let i = dropUntil; i < segments.length; i++) {
			const segment = segments[i];
			if (segment !== undefined) segment.startRow -= dropRows;
		}
		this.#compactedChildStart = dropUntil;
		this.#committedRows = Math.max(0, this.#committedRows - dropRows);
		this.#stableRowsFloor = 0;
		if (this.#nativeScrollbackLiveRegionStart !== undefined) {
			this.#nativeScrollbackLiveRegionStart = Math.max(0, this.#nativeScrollbackLiveRegionStart - dropRows);
		}
	}
}

/** Groups a run of sibling rows (an IRC card's header + body, a file-mention list, a bordered command/version panel) into a single transcript child so the */
export class TranscriptBlock extends Container {}
