import { collapseWhitespace } from "@veyyon/utils";

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface PlanSection {
	level: number;
	title: string;
	raw: string;
}

export function stripInlineMarkdown(text: string): string {
	let out = text;
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
	out = out.replace(/<([^>\s]+)>/g, "$1");
	out = out.replace(/`([^`]+)`/g, "$1");
	out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
	out = out.replace(/(\*|_)(.+?)\1/g, "$2");
	out = out.replace(/~~(.+?)~~/g, "$1");
	return collapseWhitespace(out);
}

export function parsePlanSections(text: string): PlanSection[] {
	const lines = text.split("\n");
	const offsets: number[] = new Array(lines.length);
	let cursor = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets[i] = cursor;
		cursor += lines[i]!.length + 1; // +1 for the "\n" join separator
	}

	const heads: { line: number; level: number; title: string }[] = [];
	let fenceChar: string | null = null;
	let fenceLen = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE_RE.exec(line);
		if (fenceChar === null) {
			if (fence) {
				fenceChar = fence[1]![0]!;
				fenceLen = fence[1]!.length;
			}
			if (fence) continue;
		} else {
			if (fence && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLen && fence[2]!.trim() === "") {
				fenceChar = null;
				fenceLen = 0;
			}
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) {
			heads.push({ line: i, level: heading[1]!.length, title: stripInlineMarkdown(heading[2]!) });
		}
	}

	const sections: PlanSection[] = [];
	const sliceRaw = (startLine: number, endLine: number): string => {
		const startOffset = offsets[startLine]!;
		const endOffset = endLine < lines.length ? offsets[endLine]! : text.length;
		return text.slice(startOffset, endOffset);
	};

	const firstHeadLine = heads.length > 0 ? heads[0]!.line : lines.length;
	if (firstHeadLine > 0) {
		const raw = sliceRaw(0, firstHeadLine);
		if (raw.length > 0) sections.push({ level: 0, title: "", raw });
	}

	for (let h = 0; h < heads.length; h++) {
		const head = heads[h]!;
		const endLine = h + 1 < heads.length ? heads[h + 1]!.line : lines.length;
		sections.push({ level: head.level, title: head.title, raw: sliceRaw(head.line, endLine) });
	}

	return sections;
}

export function joinPlanSections(sections: readonly PlanSection[]): string {
	let joined = "";
	for (const section of sections) joined += section.raw;
	if (joined.length === 0) return "";
	return joined.endsWith("\n") ? joined : `${joined}\n`;
}

export function sectionDeletionSpan(sections: readonly PlanSection[], index: number): number[] {
	const target = sections[index];
	if (!target || target.level === 0) return [];
	const span = [index];
	for (let j = index + 1; j < sections.length; j++) {
		if (sections[j]!.level > target.level) span.push(j);
		else break;
	}
	return span;
}
