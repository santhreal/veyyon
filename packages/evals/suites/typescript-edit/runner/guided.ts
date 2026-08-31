/**
 * Guided patch synthesis, diff previews, and mutation intent evaluation.
 *
 * Generates hashline reference patches for guided benchmark runs, builds mutation
 * diff previews against original files, and validates mutation intent at target lines.
 */

import * as path from "node:path";
import { formatHashlineHeader, InMemorySnapshotStore } from "@veyyon/hashline";
import { splitTextLines } from "@veyyon/utils";
import { diffLines } from "diff";
import type { EditTask } from "../tasks";
import { getEditPathFromArgs } from "./telemetry";
import type { BenchmarkConfig, MutationIntentValidation } from "./types";

/**
 * Build a textual hashline patch (with `¶path#tag` section header) that
 * transforms `actual` into `expected`. Returns null when no changes are
 * needed or the diff isn't expressible as straight insert/replace/delete ops.
 */
export function buildGuidedHashlinePatch(file: string, actual: string, expected: string): string | null {
	const changes = diffLines(actual, expected);
	const actualLines = actual.split("\n");
	// File-trailing newline produces a phantom empty last entry that is not a
	// real line; the hashline grammar's line numbers count real lines only.
	const fileLineCount =
		actualLines.length > 0 && actualLines[actualLines.length - 1] === ""
			? actualLines.length - 1
			: actualLines.length;

	const ops: string[] = [];
	let line = 1;
	let pendingStart = 1;
	let pendingRemoved = 0;
	let pendingAdded: string[] = [];

	const formatPayload = (body: string[]): string => (body.length === 0 ? "" : `\n${body.join("\n")}`);

	const flush = () => {
		if (pendingRemoved === 0 && pendingAdded.length === 0) return;

		if (pendingRemoved === 0) {
			// Pure insertion at `pendingStart` (line numbers are 1-indexed and
			// refer to the pre-edit file).
			if (pendingAdded.length === 0) return;
			if (pendingStart <= 1) {
				ops.push(`BOF↓${formatPayload(pendingAdded)}`);
			} else if (pendingStart > fileLineCount) {
				ops.push(`EOF↓${formatPayload(pendingAdded)}`);
			} else {
				// Insert above `pendingStart` so the new content lands at that line.
				ops.push(`${pendingStart}↑${formatPayload(pendingAdded)}`);
			}
		} else {
			const startLine = pendingStart;
			const endLine = pendingStart + pendingRemoved - 1;
			const anchor = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
			if (pendingAdded.length === 0) {
				ops.push(`${anchor}!`);
			} else {
				ops.push(`${anchor}:${formatPayload(pendingAdded)}`);
			}
		}

		pendingRemoved = 0;
		pendingAdded = [];
	};

	for (const change of changes) {
		const lines = splitTextLines(change.value);
		if (!change.added && !change.removed) {
			flush();
			line += lines.length;
			pendingStart = line;
			continue;
		}
		if (pendingRemoved === 0 && pendingAdded.length === 0) {
			pendingStart = line;
		}
		if (change.removed) {
			pendingRemoved += lines.length;
			line += lines.length;
		}
		if (change.added) {
			pendingAdded.push(...lines);
		}
	}
	flush();

	if (ops.length === 0) return null;
	const normalizedActual = actual.replace(/\r\n?/g, "\n");
	const snapshots = new InMemorySnapshotStore();
	const tag = snapshots.record(file, normalizedActual);
	const header = formatHashlineHeader(file, tag);
	return `${header}\n${ops.join("\n")}`;
}

export async function buildGuidedContext(
	task: EditTask,
	cwd: string,
	expectedDir: string,
	config: BenchmarkConfig,
): Promise<string | null> {
	if (!config.guided) return null;
	if (config.editVariant !== "hashline") return null;

	const file = task.metadata?.fileName ?? task.files[0];
	if (!file) return null;

	const actualPath = path.join(cwd, file);
	const expectedPath = path.join(expectedDir, file);
	const actual = await Bun.file(actualPath)
		.text()
		.catch(() => null);
	const expected = await Bun.file(expectedPath)
		.text()
		.catch(() => null);
	if (actual === null || expected === null) return null;

	const patch = buildGuidedHashlinePatch(file, actual, expected);
	if (patch === null) return null;
	// Rough complexity guard: too many ops or too long → skip guidance.
	const opCount = patch.split("\n").filter(l => /[↑↓→]/.test(l)).length;
	if (opCount === 0 || opCount > 25) return null;

	const args = { path: file, input: patch };
	const argsText = JSON.stringify(args, null, 2);
	if (argsText.length > 20_000) return null;
	const metaParts: string[] = [];
	if (typeof task.metadata?.lineNumber === "number") metaParts.push(`Line: ${task.metadata.lineNumber}`);
	if (typeof task.metadata?.mutationType === "string") metaParts.push(`Mutation: ${task.metadata.mutationType}`);

	return [
		`Target file: \`${file}\`${metaParts.length > 0 ? ` (${metaParts.join(", ")})` : ""}.`,
		"Apply this edit tool call (single call; copy/paste args exactly):",
		`\`\`\`diff\n${argsText}\n\`\`\``,
	].join("\n\n");
}

export function buildMutationPreviewAgainstOriginal(original: string, current: string): string | null {
	if (original === current) return null;

	const changes = diffLines(original, current);
	const preview: string[] = [];
	let origLineNum = 1;
	let newLineNum = 1;

	// Hashline diff-preview format: `-LINE:TEXT` for removed (pre-edit line
	// number), `+LINE:TEXT` for added (post-edit line number). No per-line hash.
	for (const change of changes) {
		const lines = splitTextLines(change.value);
		if (!change.added && !change.removed) {
			origLineNum += lines.length;
			newLineNum += lines.length;
			continue;
		}

		if (change.removed) {
			for (const line of lines) {
				preview.push(`-${origLineNum}:${line}`);
				origLineNum += 1;
			}
			continue;
		}

		for (const line of lines) {
			preview.push(`+${newLineNum}:${line}`);
			newLineNum += 1;
		}
	}

	return preview.length > 0 ? preview.join("\n") : null;
}

export async function collectOriginalFileContents(cwd: string, files: string[]): Promise<Map<string, string>> {
	const originals = new Map<string, string>();
	for (const file of files) {
		const fullPath = path.join(cwd, file);
		try {
			originals.set(fullPath, await Bun.file(fullPath).text());
		} catch {
			// Ignore missing files; not all tasks include all paths in every run.
		}
	}
	return originals;
}

export async function appendNoChangeMutationHint(
	error: string,
	args: unknown,
	cwd: string,
	originalFiles: Map<string, string>,
): Promise<string> {
	if (!error.includes("No changes made")) return error;
	const editPath = getEditPathFromArgs(args);
	if (!editPath) return error;

	const fullPath = editPath.startsWith("/") ? editPath : path.join(cwd, editPath);
	const original = originalFiles.get(fullPath);
	if (original === undefined) return error;

	let current: string;
	try {
		current = await Bun.file(fullPath).text();
	} catch {
		return error;
	}

	const preview = buildMutationPreviewAgainstOriginal(original, current);
	if (!preview) return error;

	return `${error}\nThe file differs from the original fixture at these lines:\n${preview}`;
}

export async function evaluateMutationIntent(
	task: EditTask,
	cwd: string,
	expectedDir: string,
): Promise<MutationIntentValidation | null> {
	const metadata = task.metadata;
	const file = metadata?.fileName ?? task.files[0];
	const lineNumber = metadata?.lineNumber;
	if (!file || typeof lineNumber !== "number" || lineNumber < 1) {
		return null;
	}

	const currentPath = file.startsWith("/") ? file : path.join(cwd, file);
	const expectedPath = file.startsWith("/") ? file : path.join(expectedDir, file);

	let currentText: string;
	let expectedText: string;
	try {
		currentText = await Bun.file(currentPath).text();
		expectedText = await Bun.file(expectedPath).text();
	} catch {
		return {
			matched: false,
			reason: "Unable to read current/expected target file for mutation-intent check.",
			mutationType: metadata?.mutationType,
			file,
			lineNumber,
		};
	}

	const currentLine = currentText.split("\n")[lineNumber - 1] ?? "";
	const expectedLine = expectedText.split("\n")[lineNumber - 1] ?? "";
	const originalSnippet = metadata?.originalSnippet;
	const mutatedSnippet = metadata?.mutatedSnippet;

	if (currentLine === expectedLine && expectedLine.length > 0) {
		return {
			matched: true,
			reason: "Target line exactly matches expected fixture.",
			mutationType: metadata?.mutationType,
			file,
			lineNumber,
		};
	}

	if (typeof originalSnippet === "string" && originalSnippet.length > 0) {
		const hasOriginal = currentLine.includes(originalSnippet);
		const stillHasMutated =
			typeof mutatedSnippet === "string" && mutatedSnippet.length > 0 ? currentLine.includes(mutatedSnippet) : false;
		if (hasOriginal && !stillHasMutated) {
			return {
				matched: true,
				reason: "Target line contains original snippet and no longer contains mutated snippet.",
				mutationType: metadata?.mutationType,
				file,
				lineNumber,
			};
		}
	}

	return {
		matched: false,
		reason: `Target line mismatch at ${file}:${lineNumber}.`,
		mutationType: metadata?.mutationType,
		file,
		lineNumber,
	};
}
