/**
 * What the bash card shows, for any host.
 *
 * The tool half in `bash.ts` runs the command; this half states what the card says about it and
 * names no colour, no glyph, no width and no viewport. The body is the command and what the program
 * wrote, so the card is data rather than a report: the outcome reaches the frame and the program's
 * output stays on the host's own ground.
 *
 * The card carries no header. Its first row is the command, and a title row above it would say
 * "Bash" over `$ ls` — the one thing a reader already knows. A failed run is stated by the frame's
 * state, which every host draws its own way.
 *
 * NEITHER SECTION IS TRIMMED HERE. How many rows a command or a stream of output occupies is known
 * only after the host wraps it, and how many rows are free is the host's viewport, so both sections
 * state a `tail` window and the host cuts the front off and says what it dropped. A collapsed card
 * additionally condenses a progress wall — a build's `Compiling …` run — into its newest line plus a
 * count, because a window spent on a thousand identical rows shows the reader nothing.
 *
 * WHAT THE TOOL STILL DECIDES, and a host never re-derives: which notices are stripped out of the
 * payload before a reader sees it. The model-facing text carries the exit code, the wall time, the
 * background hand-off and the artifact reference as sentences appended to the output; the card
 * states each of those as its own fact, so they are removed here rather than printed twice.
 */

import { getProjectDir, sanitizeText, signalName } from "@veyyon/utils";
import type { FramedBlockView, ToolViewRenderer, ViewLine, ViewSection, ViewSpan, ViewStatus } from "@veyyon/view";
import { formatExitCodeNotice } from "../../exec/exit-notice";
import { getSixelLineMask, sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import { stripOutputNotice, stripRawOutputArtifactNotice } from "../core/output-meta";
// The words a truncation is named by, from the leaf that owns them rather than from the styled
// helper beside it: a view states the sentence and never the colour it is drawn in.
import { formatTruncationMetaNotice } from "../core/output-notice";
import {
	collapseProgressRuns,
	formatToolWorkingDirectory,
	replaceTabs,
	shortenEmbeddedPaths,
} from "../core/render-utils";
import { clampTimeout } from "../core/tool-timeouts";
import { BASH_DEFAULT_PREVIEW_LINES, type BashToolDetails, formatBackgroundNotice } from "./bash";

/** The arguments the card reads off a bash call, which is any subset the model has sent so far. */
export interface BashViewArgs {
	command?: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	/** The raw streamed argument buffer, which carries `env` before the JSON object closes. */
	__partialJson?: string;
}

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface BashViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: BashToolDetails;
	isError?: boolean;
}

/** The prompt the first line of a command is read under. */
const PROMPT = "$";

/**
 * An env value inside the double quotes a preview writes it in.
 *
 * Every assignment is quoted, so a value with a space, a newline or a tab reads as one word; the
 * escapes are the ones a double-quoted shell word needs, which is the form a reader can copy.
 */
function escapeBashEnvValueForDisplay(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

/** The `NAME="value"` assignments a call carries, by name so two calls read alike. */
function formatBashEnvAssignments(env: Record<string, string> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}="${escapeBashEnvValueForDisplay(String(value))}"`)
		.join(" ");
}

/**
 * A JSON string body decoded far enough to read, for a buffer that has not closed yet.
 *
 * `JSON.parse` refuses a fragment, and the fragment is the whole point: the preview shows the env a
 * call is arriving with while its object is still open.
 */
function unescapePartialJsonString(value: string): string {
	let out = "";
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char !== "\\") {
			out += char;
			continue;
		}
		const next = value[index + 1];
		if (next === undefined) break;
		index++;
		switch (next) {
			case '"':
				out += '"';
				break;
			case "\\":
				out += "\\";
				break;
			case "/":
				out += "/";
				break;
			case "b":
				out += "\b";
				break;
			case "f":
				out += "\f";
				break;
			case "n":
				out += "\n";
				break;
			case "r":
				out += "\r";
				break;
			case "t":
				out += "\t";
				break;
			case "u": {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					out += String.fromCharCode(Number.parseInt(hex, 16));
					index += 4;
				} else {
					out += next;
				}
				break;
			}
			default:
				out += next;
		}
	}
	return out;
}

/** The `env` object of a call whose argument JSON is still arriving, as far as it has arrived. */
function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const envKey = /"env"\s*:\s*\{/.exec(partialJson);
	if (!envKey) return undefined;
	const body = partialJson.slice(envKey.index + envKey[0].length);
	const entries: Record<string, string> = {};
	const pair = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"?/g;
	let match = pair.exec(body);
	while (match !== null) {
		const name = unescapePartialJsonString(match[1] ?? "");
		if (name.length > 0) entries[name] = unescapePartialJsonString(match[2] ?? "");
		match = pair.exec(body);
	}
	return Object.keys(entries).length > 0 ? entries : undefined;
}

/**
 * The env a preview states, which is the parsed object over the streamed buffer.
 *
 * The parsed args do not always mirror the current stream prefix, so the buffer is read as well:
 * without it `NAME="…" cmd` appears only once the JSON object closes, which is after the reader has
 * already seen the command.
 */
export function bashEnvForDisplay(args: BashViewArgs): Record<string, string> | undefined {
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

/**
 * The command as the shell lines the card shows, under a prompt on the first of them.
 *
 * The command itself is the section's source, in `bash`: a terminal highlights the run, an editor
 * host hands it to its own tokenizer, and a transcript export writes a fenced block naming the
 * language. Where it ran and the environment it ran under are NOT part of what ran, so the prompt,
 * the `cd` and the assignments are the section's lead — one aside the host draws before the first
 * row and never sends to a highlighter.
 *
 * A call whose command has not arrived yet still draws its section, because the frame it anchors is
 * the one the result re-uses; a card rebuilt with no arguments at all states no command rows, since
 * a prompt over a command nobody has is a row that says nothing.
 */
function commandSection(args: BashViewArgs | undefined, expanded: boolean): ViewSection {
	const command = replaceTabs(shortenEmbeddedPaths(args?.command || "…"));
	const workdir = formatToolWorkingDirectory(args?.cwd, getProjectDir());
	const assignments = formatBashEnvAssignments(args === undefined ? undefined : bashEnvForDisplay(args));
	const prefix = [PROMPT, ...(workdir ? [`cd ${workdir} &&`] : []), ...(assignments ? [assignments] : [])].join(" ");
	const lines = args === undefined ? [] : command.split("\n").map((line): ViewLine => [{ text: line }]);
	return {
		lines,
		code: { language: "bash", lead: `${prefix} ` },
		...(expanded ? {} : { tail: {} }),
	};
}

/** The seconds a call states as its bound, clamped by the table the tool itself clamps against. */
function timeoutFromArgs(timeout: number | undefined): number | undefined {
	if (typeof timeout !== "number" || !Number.isFinite(timeout)) return undefined;
	return clampTimeout("bash", timeout);
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

/** The wall-time sentence the tool once appended to its payload, which the card states itself. */
function legacyWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

/**
 * `text` with a trailing `notice` removed, plus the newline that separated them.
 *
 * Only at the end, and only once: a notice the program itself printed mid-output is the program's
 * own line and stays.
 */
function stripTrailingNotice(text: string, notice: string): string {
	if (!notice) return text;
	const trimmed = text.trimEnd();
	if (!trimmed.endsWith(notice)) return text;
	const head = trimmed.slice(0, trimmed.length - notice.length);
	return head.endsWith("\n") ? head.slice(0, -1) : head;
}

function stripWallTimeNotice(text: string, wallTimeMs: number | undefined): string {
	if (wallTimeMs === undefined) return text;
	return stripTrailingNotice(text, legacyWallTimeNotice(wallTimeMs));
}

function stripExitCodeNotice(text: string, exitCode: number | undefined, signal?: number): string {
	if (exitCode === undefined) return text;
	return stripTrailingNotice(text, formatExitCodeNotice(exitCode, signal));
}

function stripBackgroundNotice(text: string, async: BashToolDetails["async"] | undefined): string {
	if (!async) return text;
	return stripTrailingNotice(text, formatBackgroundNotice(async.jobId, async.reason));
}

/** The program's output with every notice the tool appended for the model taken back out. */
function programOutput(result: BashViewResult): { text: string; artifactId?: string } {
	const blocks = result.content?.filter(block => block.type === "text") ?? [];
	const joined = blocks.map(block => sanitizeWithOptionalSixelPassthrough(block.text ?? "", sanitizeText)).join("\n");
	const details = result.details;
	const withoutBackground = stripBackgroundNotice(joined.trimEnd(), details?.async);
	const withoutOutputNotice = stripOutputNotice(withoutBackground, details?.meta);
	const withoutExit = stripExitCodeNotice(withoutOutputNotice, details?.exitCode, details?.signal);
	const artifact = stripRawOutputArtifactNotice(stripWallTimeNotice(withoutExit, details?.wallTimeMs));
	return {
		text: shortenEmbeddedPaths(artifact.text).trimEnd(),
		...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
	};
}

/**
 * What the run cost and how it ended, as one label.
 *
 * Every part of it is a fact the payload no longer carries: the notices were stripped above, so this
 * row is where a reader learns the exit code, the signal that killed it, the wall time, the timeout
 * it ran under and the artifact the full output was spilled to. It is a label rather than prose,
 * which is why it is stated as one — a host sets a label off in its own grammar, and the brackets
 * main wrote around these words are the terminal theme's.
 */
function statsLabel(
	result: BashViewResult,
	args: BashViewArgs | undefined,
	artifactId: string | undefined,
): ViewSpan | undefined {
	const details = result.details;
	const parts: string[] = [];
	if (details?.async?.state === "running") parts.push(`Backgrounded: ${details.async.jobId}`);
	if (details?.wallTimeMs !== undefined) parts.push(`Wall: ${formatWallTimeSeconds(details.wallTimeMs)}s`);
	// The tool states a disabled bound; a call's own `timeout: 0` never reaches this row as a zero,
	// because the argument is clamped to the floor before a card ever reads it.
	const timeoutDisabled = details?.timeoutDisabled === true;
	if (timeoutDisabled) parts.push("Timeout: disabled");
	const timeoutSeconds = timeoutDisabled ? undefined : (details?.timeoutSeconds ?? timeoutFromArgs(args?.timeout));
	if (typeof timeoutSeconds === "number") {
		const requested = details?.requestedTimeoutSeconds;
		parts.push(
			requested !== undefined && requested !== timeoutSeconds
				? `Timeout: ${timeoutSeconds}s (requested ${requested}s clamped)`
				: `Timeout: ${timeoutSeconds}s`,
		);
	}
	if (artifactId) parts.push(`Artifact: ${artifactId}`);
	if (result.isError === true && typeof details?.exitCode === "number") {
		// The signal is named here as well as in the notice the output carried, so the difference
		// between a program that exited 137 and one that was killed is visible at a glance.
		const killedBy =
			details.signal === undefined ? undefined : (signalName(details.signal) ?? `signal ${details.signal}`);
		parts.push(killedBy ? `Exit: ${details.exitCode} (${killedBy})` : `Exit: ${details.exitCode}`);
	}
	if (parts.length === 0) return undefined;
	return { text: parts.join(" | "), tone: "dim", badge: true };
}

/**
 * The program's own rows, and the facts the card states under them.
 *
 * An expanded card states every line. A collapsed one condenses each progress run into its newest
 * line plus the count it stood for, and states the window it may spend; the host measures that
 * window in the rows the lines actually occupy at its own width.
 *
 * The stats row and the truncation notice are a SECOND section, because they are facts about the run
 * rather than lines of it: inside the window they would spend rows the program's output was budgeted,
 * so a card with a wall time would show one line of output fewer than the same card without one.
 *
 * A row carrying an inline image payload is left untoned: the bytes are the program's, an image
 * protocol is a control sequence rather than text, and a colour opened around it would be written
 * into the middle of the image. A host that cannot show the image draws the row as it arrived, which
 * is what a terminal without the protocol already did.
 */
function outputSections(
	result: BashViewResult,
	args: BashViewArgs | undefined,
	expanded: boolean,
	partial: boolean,
): ViewSection[] {
	const { text, artifactId } = programOutput(result);
	// Whitespace alone is not output: a command that printed a bare newline states its facts on the
	// stats row and nothing above it, which is the row main drew too.
	const rows = text.trim().length > 0 ? text.split("\n") : [];
	const imageMask = getSixelLineMask(rows);
	const carriesImage = imageMask.some(Boolean);
	const lines: ViewLine[] = [];
	if (carriesImage) {
		// An image is as tall as it is: condensing or windowing the rows it occupies would cut the
		// payload in half, so the whole capture is stated and no window is asked for.
		for (const [index, row] of rows.entries()) {
			lines.push(
				imageMask[index] === true
					? [{ text: row }]
					: [{ text: replaceTabs(shortenEmbeddedPaths(row)), tone: "output" }],
			);
		}
	} else if (expanded) {
		for (const row of rows) lines.push([{ text: replaceTabs(shortenEmbeddedPaths(row)), tone: "output" }]);
	} else {
		for (const run of collapseProgressRuns(rows)) {
			const body: ViewSpan = { text: replaceTabs(shortenEmbeddedPaths(run.text)), tone: "output" };
			lines.push(run.hidden === 0 ? [body] : [body, { text: ` … +${run.hidden} earlier`, tone: "dim" }]);
		}
	}
	// While the output is still arriving the newest row is the live edge, which the host may animate.
	// A settled card carries the same words with nothing moving.
	if (partial && lines.length > 0) {
		const last = lines[lines.length - 1] ?? [];
		lines[lines.length - 1] = last.map(span => (span.tone === "output" ? { ...span, live: true } : span));
	}
	const notices: ViewLine[] = [];
	const stats = statsLabel(result, args, artifactId);
	if (stats !== undefined) notices.push([stats]);
	const truncation = result.details?.meta?.truncation;
	if (truncation !== undefined) {
		notices.push([{ text: formatTruncationMetaNotice(truncation), tone: "warning", badge: true }]);
	}
	return [
		{
			label: "Output",
			lines,
			...(expanded || carriesImage ? {} : { tail: { max: BASH_DEFAULT_PREVIEW_LINES, viewport: true } }),
		},
		...(notices.length > 0 ? [{ lines: notices }] : []),
	];
}

/** The state a settled, failed or still-arriving card reports. */
function resultState(result: BashViewResult, partial: boolean): ViewStatus {
	if (partial) return "pending";
	return result.isError === true ? "error" : "success";
}

export const bashToolView: Required<ToolViewRenderer<BashViewArgs, BashViewResult>> = {
	renderCall(args, context): FramedBlockView {
		return {
			kind: "framedBlock",
			state: context.frame === undefined ? "pending" : "running",
			sections: [commandSection(args, context.expanded)],
		};
	},

	renderResult(result, context, args): FramedBlockView {
		const partial = context.partial === true;
		// A settled card that failed is headed by the word, and nothing else is: a title over `$ ls`
		// would repeat the command, but the frame's colour is the only other thing that says a run
		// failed, and colour is exactly what a monochrome terminal, a colour-blind reader and a
		// copied transcript do not carry.
		const failed = !partial && result.isError === true;
		return {
			kind: "framedBlock",
			state: resultState(result, partial),
			...(failed ? { header: { kind: "statusRow", title: "failed", status: "error", titleTone: "error" } } : {}),
			sections: [commandSection(args, context.expanded), ...outputSections(result, args, context.expanded, partial)],
		};
	},
};
