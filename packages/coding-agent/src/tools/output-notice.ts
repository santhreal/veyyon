import { formatBytes, pluralize } from "@veyyon/utils/format";
import { formatGroupedDiagnosticMessages } from "../lsp/utils";

export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
	truncatedBy: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	shownRange?: { start: number; end: number };
	headRange?: { start: number; end: number };
	tailRange?: { start: number; end: number };
	elidedBytes?: number;
	elidedLines?: number;
	artifactId?: string;
	nextOffset?: number;
	elidedAmountUnknown?: boolean;
}

export type SourceMeta =
	| { type: "path"; value: string }
	| { type: "url"; value: string }
	| { type: "internal"; value: string };

export interface DiagnosticMeta {
	summary: string;
	messages: string[];
}

export interface LimitsMeta {
	matchLimit?: { reached: number; suggestion: number };
	resultLimit?: { reached: number; suggestion: number };
	headLimit?: { reached: number; suggestion: number };
	columnTruncated?: { maxColumn: number };
}

export interface OutputMeta {
	truncation?: TruncationMeta;
	source?: SourceMeta;
	diagnostics?: DiagnosticMeta;
	limits?: LimitsMeta;
}

export function formatFullOutputReference(artifactId: string): string {
	return `Read artifact://${artifactId} for full output`;
}

const RAW_OUTPUT_ARTIFACT_PREFIX = "[raw output: artifact://";
const RAW_OUTPUT_ARTIFACT_SUFFIX = "]";

export function stripRawOutputArtifactNotice(text: string): { text: string; artifactId?: string } {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidateStart = lineStart === -1 ? 0 : lineStart + 1;
	if (
		!trimmed.startsWith(RAW_OUTPUT_ARTIFACT_PREFIX, candidateStart) ||
		!trimmed.endsWith(RAW_OUTPUT_ARTIFACT_SUFFIX)
	) {
		return { text };
	}

	const idStart = candidateStart + RAW_OUTPUT_ARTIFACT_PREFIX.length;
	const idEnd = trimmed.length - RAW_OUTPUT_ARTIFACT_SUFFIX.length;
	if (idStart === idEnd) return { text };
	for (let i = idStart; i < idEnd; i++) {
		const code = trimmed.charCodeAt(i);
		if (code < 48 || code > 57) return { text };
	}

	const artifactId = trimmed.slice(idStart, idEnd);
	return {
		text: trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd(),
		artifactId,
	};
}

function isGeneratedOutputNoticeLine(line: string): boolean {
	if (!line.startsWith("[") || !line.endsWith("]")) return false;
	const body = line.slice(1, -1);
	return (
		body.startsWith("Showing ") ||
		/^\d+ matches limit reached\. Use limit=\d+ for more/u.test(body) ||
		/^\d+ results limit reached\. Use limit=\d+ for more/u.test(body) ||
		body.startsWith("Some lines truncated to ")
	);
}

export function stripGeneratedOutputNotice(text: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidateStart = lineStart === -1 ? 0 : lineStart + 1;
	if (!isGeneratedOutputNoticeLine(trimmed.slice(candidateStart))) return text;
	return trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd();
}

export function formatTruncationMetaNotice(truncation: TruncationMeta): string {
	let notice: string;

	if (truncation.direction === "middle") {
		const head = truncation.headRange;
		const tail = truncation.tailRange;
		const totalLines = truncation.totalLines;
		const elidedBytes = truncation.elidedBytes ?? Math.max(0, truncation.totalBytes - truncation.outputBytes);
		const elidedLines = truncation.elidedLines ?? Math.max(0, totalLines - truncation.outputLines);
		const headPart = head ? `lines ${head.start}-${head.end}` : "";
		const tailPart = tail ? `${tail.start}-${tail.end}` : "";
		if (headPart && tailPart) {
			notice = `Showing ${headPart} and ${tailPart} of ${totalLines}; ${elidedLines.toLocaleString()} middle ${pluralize("line", elidedLines)} (${formatBytes(elidedBytes)}) elided`;
		} else {
			notice = `Showing ${truncation.outputLines} of ${totalLines} lines; middle elided`;
		}
		if (truncation.artifactId != null) {
			notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
		}
		return notice;
	}

	if (truncation.elidedAmountUnknown) {
		notice = `Truncated upstream: ${formatBytes(truncation.outputBytes)} kept, elided amount not reported`;
		if (truncation.artifactId != null) {
			notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
		}
		return notice;
	}

	const range = truncation.shownRange;
	if (range && range.end >= range.start) {
		notice = `Showing lines ${range.start}-${range.end} of ${truncation.totalLines}`;
	} else {
		notice = `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	}

	if (truncation.truncatedBy === "bytes") {
		const maxBytes = truncation.maxBytes ?? truncation.outputBytes;
		notice += ` (${formatBytes(maxBytes)} limit)`;
	}

	if (truncation.nextOffset != null) {
		notice += `. Use :${truncation.nextOffset} to continue`;
	}

	if (truncation.artifactId != null) {
		notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
	}

	return notice;
}

export function formatOutputNotice(meta: OutputMeta | undefined): string {
	if (!meta) return "";

	const parts: string[] = [];

	if (meta.truncation) {
		parts.push(formatTruncationMetaNotice(meta.truncation));
	}

	if (meta.limits?.matchLimit) {
		const l = meta.limits.matchLimit;
		parts.push(`${l.reached} matches limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.resultLimit) {
		const l = meta.limits.resultLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.headLimit) {
		const l = meta.limits.headLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.columnTruncated) {
		parts.push(`Some lines truncated to ${meta.limits.columnTruncated.maxColumn} chars`);
	}

	let diagnosticsNotice = "";
	if (meta.diagnostics && meta.diagnostics.messages.length > 0) {
		const d = meta.diagnostics;
		diagnosticsNotice = `\n\nLSP Diagnostics (${d.summary}):\n${formatGroupedDiagnosticMessages(d.messages)}`;
	}

	const notice = parts.length ? `\n\n[${parts.join(". ")}]` : "";
	return notice + diagnosticsNotice;
}

export const RETIRED_TRUNCATION_NOTICES: ReadonlyArray<(truncation: TruncationMeta) => string | undefined> = [
	truncation => {
		if (!truncation.elidedAmountUnknown) return undefined;
		let notice = `Output was truncated before veyyon received it; ${formatBytes(truncation.outputBytes)} kept, elided amount not reported`;
		if (truncation.artifactId != null) {
			notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
		}
		return notice;
	},
];

function outputNoticeVariants(meta: OutputMeta | undefined): string[] {
	const current = formatOutputNotice(meta);
	if (!current || !meta?.truncation) return current ? [current] : [];
	const variants = [current];
	const currentTruncation = formatTruncationMetaNotice(meta.truncation);
	for (const retired of RETIRED_TRUNCATION_NOTICES) {
		const text = retired(meta.truncation);
		if (text && text !== currentTruncation) variants.push(current.replace(currentTruncation, text));
	}
	return variants;
}

export function stripOutputNotice(text: string, meta: OutputMeta | undefined): string {
	const variants = outputNoticeVariants(meta);
	if (variants.length === 0) return text;
	const trimmedText = text.trimEnd();
	for (const variant of variants) {
		const trimmedNotice = variant.trimEnd();
		if (trimmedText.endsWith(trimmedNotice)) {
			return trimmedText.slice(0, -trimmedNotice.length);
		}
	}
	return text;
}
