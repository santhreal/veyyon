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

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	getTranscriptBlockVersion?(): number;
	getTranscriptBlockSettledRows?(): number;
	isDisplaceableBlock?(): boolean;
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

function getBlockSettledRows(child: Component): number {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockSettledRows;
	if (!fn) return 0;
	const value = fn.call(child);
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function sealCommittedSnapshot(child: Component): void {
	const block = child as Component & FinalizableBlock;
	if (block.isDisplaceableBlock?.()) block.seal?.();
}

const NON_WHITESPACE = /\S/;
function isPlainBlank(line: string): boolean {
	return !NON_WHITESPACE.test(line);
}

function stripPlainBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isPlainBlank(lines[start]!)) start++;
	while (end > start && isPlainBlank(lines[end - 1]!)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

interface BlockSegment {
	component: Component;
	rawRef: readonly string[];
	contribution: readonly string[];
	width: number;
	generation: number;
	startRow: number;
	rowCount: number;
	sep: number;
	finalized: boolean;
	compactable: boolean;
	version: number | undefined;
}

const EMPTY_SEGMENTS: BlockSegment[] = [];
const EMPTY_TAIL: readonly string[] = [];

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
	#generation = 0;
	#nativeScrollbackLiveRegionStart: number | undefined;
	#lines: string[] = [];
	#segments: BlockSegment[] = EMPTY_SEGMENTS;
	#renderWidth = -1;
	#committedRows = 0;
	#compactedChildStart = 0;
	#replayPending = false;
	#droppedRows = 0;
	#retainRows = 0;
	#stableRowsFloor = 0;
	override invalidate(): void {
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
		this.#droppedRows = 0;
	}

	setNativeScrollbackRetainRows(rows: number): void {
		this.#retainRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
	}

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

	isBlockUncommitted(component: Component): boolean {
		const index = this.children.indexOf(component);
		if (index >= 0 && index < this.#compactedChildStart) return false;
		for (let si = 0; si < this.#segments.length; si++) {
			const segment = this.#segments[si];
			if (segment === undefined || segment.component !== component) continue;
			return segment.rowCount === 0 || segment.startRow >= this.#committedRows;
		}
		return true;
	}

	isBlockInLiveRegion(component: Component): boolean {
		const children = this.children;
		const index = children.indexOf(component);
		if (index < 0) return false;
		for (let i = 0; i <= index; i++) {
			if (!isBlockFinalized(children[i]!)) return true;
		}
		for (let i = index + 1; i < children.length; i++) {
			if (!isBlockFinalized(children[i]!)) return false;
		}
		return index === children.length - 1;
	}

	renderViewportTail(width: number, maxRows: number): readonly string[] {
		width = Math.max(1, width);
		if (maxRows <= 0) return EMPTY_TAIL;
		const collected: (readonly string[])[] = [];
		let total = 0;
		for (let i = this.children.length - 1; i >= this.#compactedChildStart && total < maxRows; i--) {
			const contribution = stripPlainBlankEdges(this.children[i]!.render(width));
			if (contribution.length === 0) continue;
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

		for (let i = this.#compactedChildStart; i < count && i < this.#segments.length; i++) {
			const previous = this.#segments[i];
			if (previous === undefined) continue;
			if (previous.startRow >= this.#committedRows) break;
			if (previous.rowCount === 0 || previous.component !== this.children[i]) continue;
			sealCommittedSnapshot(previous.component);
		}

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
		this.#segments = EMPTY_SEGMENTS;
		const stableFloorBefore = this.#stableRowsFloor;
		this.#stableRowsFloor = 0;
		let chainStable = this.#renderWidth === width;
		this.#renderWidth = width;
		if (!chainStable) lines.length = 0;

		let row = 0;
		let stableRows = 0;
		for (let i = this.#compactedChildStart; i < count; i++) {
			const child = this.children[i]!;

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
				previous.finalized &&
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

			const sep = row > 0 && !isPlainBlank(lines[row - 1]!) ? 1 : 0;

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

export class TranscriptBlock extends Container {}
