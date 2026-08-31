/**
 * What the read_url card shows, for any host.
 *
 * The tool half in `fetch.ts` decides what happened; this half states what the card says about it and
 * names no colour, no glyph and no width. A terminal draws the same panel it always drew through
 * `drawToolView`, and a browser draws its own from the same value: the URL is a target rather than an
 * escape sequence, the preview states how many lines it held back rather than writing the gesture for
 * seeing them, and the body is data rather than a report, which is how a host knows not to paint the
 * outcome across the page it just fetched.
 */

import { formatCount, truncate } from "@veyyon/utils/format";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { FramedBlockView, StatusRowView, ToolView, ToolViewRenderer, ViewLine, ViewSection } from "@veyyon/view";
import { applyListLimit } from "../core/list-limit";
// The notice module that owns the reference, not `output-meta`, which forwards it through the
// settings schema and the tool wrapper: this file only needs the sentence an artifact is named by.
import { formatFullOutputReference } from "../core/output-notice";
import { getDomain } from "../core/render-utils";
import { parseReadUrlTarget, type ReadUrlToolDetails } from "./fetch";

/** The arguments the card reads off a read_url call, which is the path and how it was asked for. */
export interface ReadUrlViewArgs {
	path?: string;
	url?: string;
	raw?: boolean;
}

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface ReadUrlViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: ReadUrlToolDetails;
	isError?: boolean;
}

/** Lines shown before the preview says how many it held back, at each disclosure state. */
const PREVIEW_LIMITS = { collapsed: 3, expanded: 12 } as const;

/** Count non-empty lines */
function countNonEmptyLines(text: string): number {
	return text.split("\n").filter(l => l.trim()).length;
}

function readUrlLinkTarget(input: string): string {
	try {
		return parseReadUrlTarget(input)?.path ?? input;
	} catch {
		return input;
	}
}

/**
 * The label a row gives a URL, and the target that label names.
 *
 * The label is the domain and a shortened path, which is text; the target is the URL itself, which
 * the host makes reachable. They are returned together because a row states both or neither.
 */
function readUrlDescription(input: string): { label: string; target: string } {
	const target = readUrlLinkTarget(input);
	const displayUrl = target.match(/^www\./i) ? `https://${target}` : target;
	const domain = getDomain(displayUrl);
	const urlPath = truncate(displayUrl.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	return { label: `${domain}${urlPath ? ` ${urlPath}` : ""}`.trim(), target };
}

/** A row's description and its target, or neither, for a card that may have no URL to name. */
function describeUrl(input: string | undefined): Pick<StatusRowView, "description" | "descriptionLink"> {
	if (!input) return {};
	const { label, target } = readUrlDescription(input);
	return { description: label, descriptionLink: target };
}

/** `Name: value`, where the name is secondary detail and the value is the text it introduces. */
function metadataLine(name: string, value: string): ViewLine {
	return [{ text: `${name}:`, tone: "muted" }, { text: ` ${value}` }];
}

function errorView(result: ReadUrlViewResult): FramedBlockView {
	const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
	const errorText = (rawErrorText || "No response data").replace(/^Error:\s*/, "");
	const details = result.details;
	return {
		kind: "framedBlock",
		header: {
			kind: "statusRow",
			status: "error",
			title: "Read",
			...describeUrl(details?.finalUrl ?? details?.url),
		},
		state: "error",
		sections: [
			{ lines: errorText.split("\n").map((line): ViewLine => [{ text: replaceTabs(line), tone: "error" }]) },
		],
	};
}

/** What the fetch reported about itself: how it was served, how big it was, and what was dropped. */
function metadataSection(details: ReadUrlToolDetails, body: string, truncated: boolean): ViewSection {
	const lines: ViewLine[] = [
		metadataLine("Content-Type", details.contentType || "unknown"),
		metadataLine("Method", details.method),
	];
	if (details.url !== details.finalUrl) {
		lines.push([
			{ text: "Final URL:", tone: "muted" },
			{ text: " " },
			{ text: details.finalUrl, tone: "link", link: details.finalUrl },
		]);
	}
	lines.push(metadataLine("Lines", formatCount("line", countNonEmptyLines(body))));
	lines.push(metadataLine("Chars", String(body.trim().length)));
	if (truncated) {
		lines.push([
			{ text: "", symbol: "status.warning", tone: "warning" },
			{ text: " Output truncated", tone: "warning" },
		]);
		const artifactId = details.meta?.truncation?.artifactId;
		if (artifactId) lines.push([{ text: formatFullOutputReference(artifactId), tone: "warning" }]);
	}
	if (details.notes.length > 0) lines.push(metadataLine("Notes", details.notes.join("; ")));
	return { label: "Metadata", lines };
}

/** The head of the fetched page, and how much of it the card is not showing. */
function previewSection(body: string, expanded: boolean): ViewSection {
	const contentLines = body.split("\n").filter(l => l.trim());
	const shown = applyListLimit(contentLines, {
		headLimit: expanded ? PREVIEW_LIMITS.expanded : PREVIEW_LIMITS.collapsed,
	}).items;
	const lines: ViewLine[] =
		shown.length > 0
			? shown.map((line): ViewLine => [{ text: line.trimEnd(), tone: "dim" }])
			: [[{ text: "(no content)", tone: "dim" }]];
	const remaining = Math.max(0, contentLines.length - shown.length);
	return {
		label: "Content Preview",
		lines,
		// Only when something is missing: a preview that shows the whole page holds nothing back, and a
		// host offered a gesture for nothing would be pointing at rows that are already there.
		hidden:
			remaining > 0 ? { count: remaining, noun: { one: "line", many: "lines" }, revealable: !expanded } : undefined,
	};
}

/**
 * How read_url describes its call and its result.
 *
 * The result body is what the tool returned minus the metadata preamble the fetch writes above it,
 * split on the `---` rule that separates the two.
 */
export const readUrlToolView: Required<ToolViewRenderer<ReadUrlViewArgs, ReadUrlViewResult>> = {
	renderCall(args): ToolView {
		return {
			kind: "statusRow",
			status: "pending",
			title: "Read",
			...describeUrl(args.path ?? args.url ?? ""),
			meta: args.raw ? [{ text: "raw" }] : undefined,
		};
	},

	renderResult(result, context): ToolView {
		const details = result.details;
		if (result.isError || !details) return errorView(result);

		const contentText = result.content[0]?.text ?? "";
		const body = contentText.includes("---\n\n")
			? contentText.split("---\n\n").slice(1).join("---\n\n")
			: contentText;
		const truncated = Boolean(details.truncated || details.meta?.truncation);

		return {
			kind: "framedBlock",
			header: {
				kind: "statusRow",
				status: truncated ? "warning" : "success",
				title: "Read",
				...describeUrl(details.finalUrl),
			},
			state: truncated ? "warning" : "success",
			// The body is the page, not a verdict on it.
			contents: "data",
			sections: [metadataSection(details, body, truncated), previewSection(body, context.expanded)],
		};
	},
};
