/**
 * Differential oracle: edit-main-renderer from origin/main.
 * Source SHA: d0cb967888303de02e573bb8b0f3c5ba6fe66377
 */
import type { EditToolDetails } from "@veyyon/coding-agent/edit/details";
import type { DiffError, DiffResult } from "@veyyon/coding-agent/edit/diff";
import type { Operation } from "@veyyon/coding-agent/edit/modes/patch";
import type { PerFileDiffPreview } from "@veyyon/coding-agent/edit/streaming";
import type { EditMode } from "@veyyon/coding-agent/utils/edit-mode";
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("edit-main-renderer");

export type EditRenderEntry = {
	path?: unknown;
	rename?: unknown;
	move?: unknown;
	op?: Operation;
};

export interface EditRenderArgs {
	path?: unknown;
	file_path?: unknown;
	oldText?: string;
	newText?: string;
	patch?: string;
	input?: string;
	_input?: string;
	all?: boolean;
	op?: Operation;
	rename?: unknown;
	diff?: string;
	previewDiff?: string;
	__partialJson?: string;
	edits?: EditRenderEntry[];
}

export interface EditRenderContext {
	editMode?: EditMode;
	editDiffPreview?: DiffResult | DiffError;
	perFileDiffPreview?: PerFileDiffPreview[];
	editStreamingFallback?: string;
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
}

export interface EditRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: EditToolDetails;
	isError?: boolean;
}

export const editToolRenderer = oracle.editToolRenderer as LegacyRenderer;
