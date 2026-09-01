import type { Component } from "@veyyon/tui";

export interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	getTranscriptBlockVersion?(): number;
	getTranscriptBlockSettledRows?(): number;
	isDisplaceableBlock?(): boolean;
	seal?(): void;
}

export function isBlockFinalized(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockFinalized;
	return fn ? fn.call(child) : true;
}

export function getBlockVersion(child: Component): number | undefined {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockVersion;
	return fn ? fn.call(child) : undefined;
}

export function getBlockSettledRows(child: Component): number {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockSettledRows;
	if (!fn) return 0;
	const value = fn.call(child);
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function sealCommittedSnapshot(child: Component): void {
	const block = child as Component & FinalizableBlock;
	if (block.isDisplaceableBlock?.()) block.seal?.();
}

export const NON_WHITESPACE = /\S/;
export function isPlainBlank(line: string): boolean {
	return !NON_WHITESPACE.test(line);
}

export function stripPlainBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isPlainBlank(lines[start]!)) start++;
	while (end > start && isPlainBlank(lines[end - 1]!)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

export interface BlockSegment {
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

export const EMPTY_SEGMENTS: BlockSegment[] = [];
export const EMPTY_TAIL: readonly string[] = [];
