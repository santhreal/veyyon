import type { JsonObject, Snapshot } from "./types";

export function snapshotDump(snapshot: Snapshot): JsonObject {
	return {
		buffer: snapshot.buffer,
		view: snapshot.view,
		viewBackgroundColumns: snapshot.viewBackgroundColumns,
		frameBackgroundColumns: snapshot.frameBackgroundColumns,
		position: { baseY: snapshot.position.baseY, viewportY: snapshot.position.viewportY },
		cursor: cursorObject(snapshot),
		expectedCursor:
			snapshot.expectedCursor === null
				? null
				: { row: snapshot.expectedCursor.row, col: snapshot.expectedCursor.col },
		redraws: snapshot.redraws,
		width: snapshot.width,
		height: snapshot.height,
		frame: snapshot.frame,
		atBottom: snapshot.atBottom,
	};
}

export function snapshotSummary(snapshot: Snapshot): JsonObject {
	return {
		bufferLength: snapshot.buffer.length,
		view: snapshot.view,
		viewBackgroundColumns: snapshot.viewBackgroundColumns,
		position: { baseY: snapshot.position.baseY, viewportY: snapshot.position.viewportY },
		cursor: cursorObject(snapshot),
		expectedCursor:
			snapshot.expectedCursor === null
				? null
				: { row: snapshot.expectedCursor.row, col: snapshot.expectedCursor.col },
		redraws: snapshot.redraws,
		width: snapshot.width,
		height: snapshot.height,
		frameLength: snapshot.frame.length,
		frameTail: snapshot.frame.slice(-Math.min(snapshot.height + 3, snapshot.frame.length)),
		atBottom: snapshot.atBottom,
	};
}

export function cursorObject(snapshot: Snapshot): JsonObject {
	return { row: snapshot.cursor.row, col: snapshot.cursor.col };
}

export function maxOf(values: readonly number[]): number {
	let max = values[0] ?? 0;
	for (const value of values) {
		if (value > max) max = value;
	}
	return max;
}

export function parsePositiveInt(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined || raw.length === 0) return fallback;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
	}
	return Number.parseInt(raw, 10);
}

export function formatSeed(seed: number): string {
	return `0x${(seed >>> 0).toString(16).padStart(8, "0")}`;
}
