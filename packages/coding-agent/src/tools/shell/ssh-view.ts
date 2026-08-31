/**
 * What the ssh card shows, for any host.
 *
 * The tool half in `ssh.ts` runs the command; this half states what the card says about it and names
 * no colour, no glyph and no width. The body is the command and what the remote host wrote back, so
 * the card is data rather than a report: the outcome goes on the card's edge and the transcript
 * stays on its ordinary ground.
 *
 * Neither section is trimmed by the tool. How many rows a command occupies is known only after the
 * host wraps it, and how many rows are free is the host's viewport, so both sections state
 * `tail` and the host cuts the front off the window and says how much it dropped. Expanding the card
 * drops the window and shows all of it.
 */

import type { FramedBlockView, StatusRowView, ToolViewRenderer, ViewLine, ViewSection } from "@veyyon/view";
import { stripOutputNotice } from "../core/output-meta";
import { formatTruncationMetaNotice } from "../core/output-notice";
import { PREVIEW_LIMITS, replaceTabs } from "../core/render-utils";
import type { SSHToolDetails } from "./ssh";

/** The arguments the card reads off an ssh call, which is any subset the model has sent so far. */
export interface SshViewArgs {
	host?: string;
	command?: string;
	timeout?: number;
}

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface SshViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: SSHToolDetails;
	isError?: boolean;
}

/** The emblem a settled ssh card is titled by, instead of a success tick. */
const SSH_EMBLEM = "tool.ssh";

/** The prompt the first line of a remote command is read under. */
const PROMPT = "$ ";

/**
 * The command as the lines the card shows, under a prompt on the first of them.
 *
 * A call whose command has not arrived yet still draws its section, because the frame it anchors is
 * the one the result re-uses: an empty section would move every row of the card when the first
 * argument lands.
 */
function commandSection(command: string, expanded: boolean): ViewSection {
	const sanitized = replaceTabs(command);
	const lines = (sanitized.length > 0 ? sanitized.split("\n") : ["…"]).map((line, index): ViewLine =>
		index === 0 ? [{ text: PROMPT, tone: "dim" }, { text: line }] : [{ text: line }],
	);
	return { lines, tail: expanded ? undefined : {} };
}

/**
 * What the remote host wrote, and the note the tool's own limits left on it.
 *
 * The model-facing notice is stripped first: the card states truncation in its own words just below,
 * and printing both says the same thing twice in two registers.
 */
function outputSection(result: SshViewResult, expanded: boolean): ViewSection {
	const text = result.content?.find(block => block.type === "text")?.text ?? "";
	const output = stripOutputNotice(text, result.details?.meta).trimEnd();
	const lines: ViewLine[] = output
		? output.split("\n").map((line): ViewLine => [{ text: replaceTabs(line), tone: "output" }])
		: [];
	const truncation = result.details?.meta?.truncation;
	if (truncation !== undefined) {
		lines.push([{ text: formatTruncationMetaNotice(truncation), tone: "warning" }]);
	}
	return {
		label: "Output",
		lines,
		tail: expanded ? undefined : { max: PREVIEW_LIMITS.OUTPUT_COLLAPSED },
	};
}

/** The row an ssh card is headed by, which names the host and states how the command ended. */
function header(host: string, settled: boolean, isError: boolean): StatusRowView {
	return {
		kind: "statusRow",
		status: settled && !isError ? "success" : isError ? "error" : "pending",
		emblem: settled && !isError ? SSH_EMBLEM : undefined,
		title: "SSH",
		description: `[${host}]`,
	};
}

export const sshToolView: Required<ToolViewRenderer<SshViewArgs, SshViewResult>> = {
	renderCall(args, context): FramedBlockView {
		return {
			kind: "framedBlock",
			header: {
				kind: "statusRow",
				status: context.partial === false ? "pending" : "running",
				title: "SSH",
				description: `[${args.host || "…"}]`,
			},
			state: context.partial === false ? "pending" : "running",
			contents: "data",
			sections: [commandSection(args.command ?? "", context.expanded)],
		};
	},

	renderResult(result, context, args): FramedBlockView {
		const settled = context.partial !== true;
		const isError = result.isError === true;
		return {
			kind: "framedBlock",
			header: header(args?.host || "…", settled, isError),
			state: isError ? "error" : settled ? "success" : "pending",
			// The body is the remote host's own output, not a verdict on it.
			contents: "data",
			sections: [commandSection(args?.command ?? "", context.expanded), outputSection(result, context.expanded)],
		};
	},
};
