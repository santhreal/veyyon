import { toolResultNeverRan } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { Container, Text } from "@veyyon/tui";
import { formatCount } from "@veyyon/utils";
import { getLanguageFromPath, theme } from "../../modes/theme/theme";
import { splitPathAndSel } from "../../tools/path-utils";
import type { ReadRenderArgs } from "../../tools/read";
import { shortenPath } from "../../tools/render-utils";
import { fileHyperlink, renderCodeCell } from "../../tui";
import type {
	ReadDisplayTarget,
	ReadEntry,
	ReadSummaryRow,
	ReadToolGroupOptions,
	ReadToolResultDetails,
} from "./read-tool-group-helpers";

import {
	COLLAPSED_PREVIEW_LINES,
	displayPathWithSuffixResolution,
	firstSelectorLine,
	firstSelectorLineForTargets,
	formatMergedSelectorParts,
	getDisplayReadTargets,
	getSuffixResolution,
	linkPathForTargets,
	READ_STATUS_RANK,
	readArgsTarget,
	readResultLinkPath,
	readTargetLinkPath,
	splitReadDisplayPathSpecs,
	splitSelectorDisplayParts,
} from "./read-tool-group-helpers";
import type { ToolExecutionHandle } from "./tool-execution";

export { readArgsHaveTarget, readArgsTargetInternalUrl } from "./read-tool-group-helpers";

export class ReadToolGroupComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, ReadEntry>();
	#text: Text;
	#expanded = false;
	#showContentPreview: boolean;
	#finalized = false;
	#sealed = false;

	constructor(options: ReadToolGroupOptions = {}) {
		super();
		this.#showContentPreview = options.showContentPreview ?? false;
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
		this.#updateDisplay();
	}

	isTranscriptBlockFinalized(): boolean {
		if (this.#sealed) return true;
		if (!this.#finalized) return false;
		return !this.#hasPendingEntries();
	}

	#hasPendingEntries(): boolean {
		for (const entry of this.#entries.values()) {
			if (entry.status === "pending") return true;
		}
		return false;
	}

	finalize(): void {
		this.#finalized = true;
	}

	seal(): void {
		this.#sealed = true;
	}

	updateArgs(args: ReadRenderArgs, toolCallId?: string): void {
		if (!toolCallId) return;
		const rawPath = readArgsTarget(args) ?? "";
		const entry: ReadEntry = this.#entries.get(toolCallId) ?? {
			toolCallId,
			path: rawPath,
			status: "pending",
		};
		entry.path = rawPath;
		this.#entries.set(toolCallId, entry);
		this.#updateDisplay();
	}

	updateResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry) return;
		if (isPartial) return;
		if (toolResultNeverRan(result.details)) {
			entry.status = "notExecuted";
			this.#updateDisplay();
			return;
		}
		const details = result.details as ReadToolResultDetails | undefined;
		const suffixResolution = getSuffixResolution(details);
		const displayPaths = getDisplayReadTargets(details);
		entry.linkPath = readResultLinkPath(details);
		if (suffixResolution) {
			entry.path = displayPathWithSuffixResolution(entry.path, suffixResolution);
			entry.correctedFrom = suffixResolution.from;
			entry.displayPaths = undefined;
		} else {
			entry.correctedFrom = undefined;
			entry.displayPaths = displayPaths;
		}
		const conflictCount =
			typeof details?.conflictCount === "number" && details.conflictCount > 0 ? details.conflictCount : undefined;
		entry.conflictCount = conflictCount;
		entry.status = result.isError ? "error" : suffixResolution ? "warning" : "success";
		const displayContent = details?.displayContent;
		const textContent = result.content?.find(c => c.type === "text")?.text;
		if (displayContent !== undefined || textContent !== undefined) {
			entry.contentText = displayContent?.text ?? textContent;
			entry.codeStartLine = displayContent?.startLine;
			entry.codeLineNumbers = displayContent?.lineNumbers;
		}
		this.#updateDisplay();
	}

	setArgsComplete(_toolCallId?: string): void {
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	getComponent(): Component {
		return this;
	}

	#updateDisplay(): void {
		const entries = Array.from(this.#entries.values());
		const displayTargets = this.#displayTargetsForEntries(entries);
		const displayRows = this.#buildSummaryRows(displayTargets);

		this.clear();
		this.#text = new Text("", 0, 0);

		if (displayRows.length === 0) {
			this.#text.setText(` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))}`);
			this.addChild(this.#text);
			return;
		}

		if (displayRows.length === 1) {
			const row = displayRows[0]!;
			if (!this.#shouldRenderPreviewRow(row)) {
				const statusSymbol = this.#formatStatus(this.#statusForTargets(row.targets));
				const pathDisplay = this.#formatRowPath(row);
				this.#text.setText(
					` ${statusSymbol} ${theme.fg("toolTitle", theme.bold("Read"))} ${pathDisplay}`.trimEnd(),
				);
				this.addChild(this.#text);
			}
			const previewEntries = this.#previewEntriesForRow(row);
			for (let pi = 0; pi < previewEntries.length; pi++) {
				this.#addContentPreview(previewEntries[pi]!);
			}
			return;
		}

		const header = `${theme.fg("toolTitle", theme.bold("Read"))}${theme.fg("dim", ` (${displayRows.length})`)}`;
		const lines = [` ${theme.format.bullet} ${header}`];
		const entriesWithoutPreview: ReadEntry[] = [];
		for (let ei = 0; ei < entries.length; ei++) {
			if (!this.#shouldRenderPreview(entries[ei]!)) entriesWithoutPreview.push(entries[ei]!);
		}
		const summaryTargets = this.#displayTargetsForEntries(entriesWithoutPreview);
		const rows = this.#buildSummaryRows(summaryTargets);
		for (let ri = 0; ri < rows.length; ri++) {
			this.#appendSummaryRow(lines, rows[ri]!, ri, rows.length);
		}

		this.#text.setText(lines.join("\n"));
		this.addChild(this.#text);

		for (let ei = 0; ei < entries.length; ei++) {
			const entry = entries[ei]!;
			if (this.#shouldRenderPreview(entry)) {
				this.#addContentPreview(entry);
			}
		}
	}

	#displayTargetsForEntries(entries: ReadEntry[]): ReadDisplayTarget[] {
		const targets: ReadDisplayTarget[] = [];
		for (let ei = 0; ei < entries.length; ei++) {
			const entry = entries[ei]!;
			const pathSpecs = entry.displayPaths ?? splitReadDisplayPathSpecs(entry.path);
			const useEntryLinkPath = pathSpecs.length === 1;
			for (let pi = 0; pi < pathSpecs.length; pi++) {
				const pathSpec = pathSpecs[pi]!;
				const split = splitPathAndSel(pathSpec);
				const linkPath = readTargetLinkPath(split.path, useEntryLinkPath ? entry.linkPath : undefined);
				const selectors = splitSelectorDisplayParts(split.sel);
				for (let si = 0; si < selectors.length; si++) {
					const selector = selectors[si]!;
					targets.push({
						entry,
						targetPath: selector ? `${split.path}:${selector}` : pathSpec,
						basePath: split.path,
						linkPath,
						selector,
					});
				}
			}
		}
		return targets;
	}

	#buildSummaryRows(targets: ReadDisplayTarget[]): ReadSummaryRow[] {
		const selectorTargetsByBasePath = new Map<string, ReadDisplayTarget[]>();
		for (let ti = 0; ti < targets.length; ti++) {
			const target = targets[ti]!;
			if (!target.selector) continue;
			const existing = selectorTargetsByBasePath.get(target.basePath);
			if (existing) existing.push(target);
			else selectorTargetsByBasePath.set(target.basePath, [target]);
		}

		const mergeableBasePaths = new Set<string>();
		for (const [basePath, baseTargets] of selectorTargetsByBasePath) {
			if (basePath && baseTargets.length > 1) {
				mergeableBasePaths.add(basePath);
			}
		}

		const emittedMergedRows = new Set<string>();
		const rows: ReadSummaryRow[] = [];
		for (let ti = 0; ti < targets.length; ti++) {
			const target = targets[ti]!;
			if (target.selector && mergeableBasePaths.has(target.basePath)) {
				if (!emittedMergedRows.has(target.basePath)) {
					const mergedTargets = selectorTargetsByBasePath.get(target.basePath) ?? [target];
					const selectors: string[] = [];
					for (let mi = 0; mi < mergedTargets.length; mi++) {
						const sel = mergedTargets[mi]!.selector;
						if (sel !== undefined) selectors.push(sel);
					}
					rows.push({
						targetPath: `${target.basePath}:${formatMergedSelectorParts(selectors)}`,
						basePath: target.basePath,
						targets: mergedTargets,
					});
					emittedMergedRows.add(target.basePath);
				}
				continue;
			}
			rows.push({ targetPath: target.targetPath, basePath: target.basePath, targets: [target] });
		}
		return rows;
	}

	#appendSummaryRow(lines: string[], row: ReadSummaryRow, index: number, total: number): void {
		const connector = index === total - 1 ? theme.tree.last : theme.tree.branch;
		lines.push(`   ${theme.fg("dim", connector)} ${this.#formatRow(row)}`.trimEnd());
	}

	#formatRow(row: ReadSummaryRow): string {
		const status = this.#statusForTargets(row.targets);
		const statusPrefix = status === "success" ? "" : `${this.#formatStatus(status)} `;
		return `${statusPrefix}${this.#formatRowPath(row)}`;
	}

	#formatRowPath(row: ReadSummaryRow): string {
		return this.#formatPathValue(row.targetPath, {
			correctedFrom: this.#correctedFromForTargets(row.targets),
			conflictCount: this.#conflictCountForTargets(row.targets),
			line: firstSelectorLineForTargets(row.targets),
			linkPath: linkPathForTargets(row.targets),
		});
	}

	#statusForTargets(targets: ReadDisplayTarget[]): ReadEntry["status"] {
		let status: ReadEntry["status"] = "success";
		for (let ti = 0; ti < targets.length; ti++) {
			if (READ_STATUS_RANK[targets[ti]!.entry.status] > READ_STATUS_RANK[status]) {
				status = targets[ti]!.entry.status;
			}
		}
		return status;
	}

	#correctedFromForTargets(targets: ReadDisplayTarget[]): string | undefined {
		for (let ti = 0; ti < targets.length; ti++) {
			if (targets[ti]!.entry.correctedFrom) return targets[ti]!.entry.correctedFrom;
		}
		return undefined;
	}

	#conflictCountForTargets(targets: ReadDisplayTarget[]): number | undefined {
		let conflictCount = 0;
		for (let ti = 0; ti < targets.length; ti++) {
			const cc = targets[ti]!.entry.conflictCount;
			if (cc && cc > conflictCount) {
				conflictCount = cc;
			}
		}
		return conflictCount > 0 ? conflictCount : undefined;
	}

	#previewEntriesForRow(row: ReadSummaryRow): ReadEntry[] {
		const entries: ReadEntry[] = [];
		const seen = new Set<string>();
		for (let ti = 0; ti < row.targets.length; ti++) {
			const target = row.targets[ti]!;
			if (seen.has(target.entry.toolCallId) || !this.#shouldRenderPreview(target.entry)) continue;
			entries.push(target.entry);
			seen.add(target.entry.toolCallId);
		}
		return entries;
	}

	#shouldRenderPreviewRow(row: ReadSummaryRow): boolean {
		return this.#previewEntriesForRow(row).length > 0;
	}

	#formatPathValue(
		value: string,
		options: { correctedFrom?: string; conflictCount?: number; line?: number; linkPath?: string } = {},
	): string {
		const split = splitPathAndSel(value);
		const selectorSuffix = split.sel ? `:${split.sel}` : "";
		const baseValue = split.sel ? split.path : value;
		const filePath = shortenPath(baseValue);
		let pathDisplay = filePath ? theme.fg("accent", filePath) : theme.fg("toolOutput", "…");
		if (filePath && options.linkPath) {
			const linkOptions = options.line !== undefined ? { line: options.line } : undefined;
			pathDisplay = fileHyperlink(options.linkPath, pathDisplay, linkOptions);
		}
		if (selectorSuffix) {
			pathDisplay += theme.fg("accent", selectorSuffix);
		}
		if (options.correctedFrom) {
			pathDisplay += theme.fg("dim", ` (corrected from ${shortenPath(options.correctedFrom)})`);
		}
		pathDisplay += this.#formatConflictBadge(options.conflictCount);
		return pathDisplay;
	}

	#formatConflictBadge(conflictCount: number | undefined): string {
		if (!conflictCount || conflictCount <= 0) return "";
		return ` ${theme.fg("warning", `(warn ${formatCount("conflict", conflictCount)})`)}`;
	}

	#addContentPreview(entry: ReadEntry): void {
		const split = splitPathAndSel(entry.path);
		const lang = getLanguageFromPath(split.path);
		const pathValue = shortenPath(entry.path);
		const pathDisplay = pathValue
			? this.#formatPathValue(entry.path, {
					correctedFrom: entry.correctedFrom,
					conflictCount: entry.conflictCount,
					line: firstSelectorLine(split.sel),
					linkPath: readTargetLinkPath(split.path, entry.linkPath),
				})
			: "";
		const title = pathDisplay ? `Read ${pathDisplay}` : "Read";
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		const expanded = this.#expanded;
		const component: Component = {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedLines = renderCodeCell(
					{
						code: entry.contentText ?? "",
						language: lang,
						title,
						status:
							entry.status === "success"
								? "complete"
								: entry.status === "notExecuted"
									? "warning"
									: entry.status,
						expanded,
						codeMaxLines: expanded ? undefined : COLLAPSED_PREVIEW_LINES,
						codeStartLine: entry.codeStartLine,
						codeLineNumbers: entry.codeLineNumbers,
						width,
					},
					theme,
				);
				cachedWidth = width;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
		this.addChild(component);
	}

	#shouldRenderPreview(entry: ReadEntry): boolean {
		return this.#showContentPreview && entry.contentText !== undefined;
	}

	#formatStatus(status: ReadEntry["status"]): string {
		if (status === "success") {
			return theme.fg("text", theme.status.enabled);
		}
		if (status === "warning") {
			return theme.fg("warning", theme.status.warning);
		}
		if (status === "notExecuted") {
			return theme.fg("dim", theme.status.warning);
		}
		if (status === "error") {
			return theme.fg("error", theme.status.error);
		}
		return theme.fg("dim", theme.status.pending);
	}
}
