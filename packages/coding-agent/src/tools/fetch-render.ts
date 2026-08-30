/**
 * Terminal drawing for the read_url tool. The tool half in `fetch.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import { type Component, Text } from "@veyyon/tui";
import { formatCount, formatMoreLines, truncate } from "@veyyon/utils/format";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { theme } from "../theme/theme-binding";
import type { Theme } from "../theme/theme-class";
import { urlHyperlink } from "../tui/hyperlink";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import { renderStatusLine } from "../tui/status-line";
import { parseReadUrlTarget, type ReadUrlToolDetails } from "./fetch";
import { applyListLimit } from "./list-limit";
import { formatStyledArtifactReference } from "./output-meta";
import { formatExpandHint, getDomain, replaceTabs } from "./render-utils";

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

function formatReadUrlDescription(input: string): string {
	const target = readUrlLinkTarget(input);
	const displayUrl = target.match(/^www\./i) ? `https://${target}` : target;
	const domain = getDomain(displayUrl);
	const urlPath = truncate(displayUrl.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	const label = `${domain}${urlPath ? ` ${urlPath}` : ""}`.trim();
	return urlHyperlink(target, label);
}

function formatReadUrlMetadataValue(url: string, uiTheme: Theme): string {
	return urlHyperlink(url, uiTheme.fg("mdLinkUrl", url));
}

/** Render URL read call (URL preview) */
export function renderReadUrlCall(
	args: { path?: string; url?: string; raw?: boolean },
	_options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const url = args.path ?? args.url ?? "";
	const description = formatReadUrlDescription(url);
	const meta: string[] = [];
	if (args.raw) meta.push("raw");
	const text = renderStatusLine({ icon: "pending", title: "Read", description, meta }, uiTheme);
	return new Text(text, 0, 0);
}

/** Render URL read result with tree-based layout */
export function renderReadUrlResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ReadUrlToolDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const details = result.details;

	if (result.isError || !details) {
		const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
		const errorText = (rawErrorText || "No response data").replace(/^Error:\s*/, "");
		const urlText = details?.finalUrl ?? details?.url ?? "";
		const description = urlText ? formatReadUrlDescription(urlText) : undefined;
		const header = renderStatusLine({ icon: "error", title: "Read", description }, uiTheme);
		const errorLines = errorText.split("\n").map(line => uiTheme.fg("error", replaceTabs(line)));
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render: (width: number) =>
				outputBlock.render({ header, state: "error", sections: [{ lines: errorLines }], width }, uiTheme),
			invalidate: () => outputBlock.invalidate(),
		});
	}

	const description = formatReadUrlDescription(details.finalUrl);
	const hasRedirect = details.url !== details.finalUrl;
	const hasNotes = details.notes.length > 0;
	const truncation = details.meta?.truncation;
	const truncated = Boolean(details.truncated || truncation);

	const header = renderStatusLine(
		{
			icon: truncated ? "warning" : "success",
			title: "Read",
			description,
		},
		uiTheme,
	);

	const contentText = result.content[0]?.text ?? "";
	const contentBody = contentText.includes("---\n\n")
		? contentText.split("---\n\n").slice(1).join("---\n\n")
		: contentText;
	const lineCount = countNonEmptyLines(contentBody);
	const charCount = contentBody.trim().length;
	const contentLines = contentBody.split("\n").filter(l => l.trim());

	const metadataLines: string[] = [
		`${uiTheme.fg("muted", "Content-Type:")} ${details.contentType || "unknown"}`,
		`${uiTheme.fg("muted", "Method:")} ${details.method}`,
	];
	if (hasRedirect) {
		metadataLines.push(
			`${uiTheme.fg("muted", "Final URL:")} ${formatReadUrlMetadataValue(details.finalUrl, uiTheme)}`,
		);
	}
	const lineLabel = `${formatCount("line", lineCount)}`;
	metadataLines.push(`${uiTheme.fg("muted", "Lines:")} ${lineLabel}`);
	metadataLines.push(`${uiTheme.fg("muted", "Chars:")} ${charCount}`);
	if (truncated) {
		metadataLines.push(uiTheme.fg("warning", `${uiTheme.status.warning} Output truncated`));
		if (truncation?.artifactId) metadataLines.push(formatStyledArtifactReference(truncation.artifactId, uiTheme));
	}
	if (hasNotes) {
		metadataLines.push(`${uiTheme.fg("muted", "Notes:")} ${details.notes.join("; ")}`);
	}

	const outputBlock = new CachedOutputBlock();
	let lastExpanded: boolean | undefined;
	let contentPreviewLines: string[] | undefined;

	return markFramedBlockComponent({
		render: (width: number) => {
			const { expanded } = options;

			if (contentPreviewLines === undefined || lastExpanded !== expanded) {
				const previewLimit = expanded ? 12 : 3;
				const previewList = applyListLimit(contentLines, { headLimit: previewLimit });
				const previewLines = previewList.items.map(line => line.trimEnd());
				const remaining = Math.max(0, contentLines.length - previewList.items.length);
				contentPreviewLines =
					previewLines.length > 0
						? previewLines.map(line => uiTheme.fg("dim", line))
						: [uiTheme.fg("dim", "(no content)")];
				if (remaining > 0) {
					const hint = formatExpandHint(uiTheme, expanded, true);
					contentPreviewLines.push(
						uiTheme.fg("muted", `… ${formatMoreLines(remaining)}${hint ? ` ${hint}` : ""}`),
					);
				}
				lastExpanded = expanded;
				outputBlock.invalidate();
			}

			return outputBlock.render(
				{
					header,
					state: truncated ? "warning" : "success",
					sections: [
						{ label: uiTheme.fg("toolTitle", "Metadata"), lines: metadataLines },
						{ label: uiTheme.fg("toolTitle", "Content Preview"), lines: contentPreviewLines },
					],
					width,
					applyBg: false,
				},
				uiTheme,
			);
		},
		invalidate: () => {
			outputBlock.invalidate();
			contentPreviewLines = undefined;
			lastExpanded = undefined;
		},
	});
}
