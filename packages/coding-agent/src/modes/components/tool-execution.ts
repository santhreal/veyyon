import { type AnyAgentTool, type SyntheticToolResultDetails, toolResultNeverRan } from "@veyyon/agent-core";
import type { SnapshotStore } from "@veyyon/hashline";
import {
	Box,
	type Component,
	Container,
	getImageDimensions,
	Image,
	ImageProtocol,
	imageFallback,
	type NativeScrollbackLiveRegion,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
} from "@veyyon/tui";
import { clampLow, formatMoreLines, getProjectDir, logger, sanitizeText } from "@veyyon/utils";
import { EDIT_MODE_STRATEGIES, type EditMode, type PerFileDiffPreview } from "../../edit";
import type { Theme } from "../../modes/theme/theme";
import { getThemeEpoch, theme } from "../../modes/theme/theme";
import { BASH_DEFAULT_PREVIEW_LINES } from "../../tools/bash";
// From the renderer that owns the number, not from `tools/eval`, which is the tool that RUNS a cell: reading
// a preview height should not instantiate the Python kernel machinery.
import { EVAL_DEFAULT_PREVIEW_LINES } from "../../tools/eval-render";
import { isWaitingPollDetails } from "../../tools/job";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "../../tools/json-tree";
import {
	formatExpandHint,
	formatStatusIcon,
	replaceTabs,
	resolveImageOptions,
	truncateToWidth,
} from "../../tools/render-utils";
import { type FirstResultViewportRepaint, toolRenderers } from "../../tools/renderers";
import { TODO_STRIKE_TOTAL_FRAMES, type TodoToolDetails } from "../../tools/todo";
import { renderStatusLine, WidthAwareText } from "../../tui";
import { sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import { renderDiff } from "./diff";
import { reportRendererFailure } from "./renderer-failure";

/**
 * Drop trailing removal/hunk-header lines that appear in a streaming diff
 * before the matching `+added` lines have arrived. Without this, a partial
 * apply_patch / hashline preview shows `-old` first and then visibly grows
 * the `+new` block beneath it — the "removals first, additions catching up"
 * jitter. Once the next streaming tick brings the additions in, the trailing
 * block reappears alongside them.
 */
function stripTrailingUnbalancedRemoval(diff: string | undefined): string | undefined {
	if (!diff) return diff;
	const lines = diff.split("\n");
	let lastAddIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith("+")) {
			lastAddIdx = i;
			break;
		}
	}
	let hasTrailingUnbalanced = false;
	for (let i = lastAddIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("-") || line.startsWith("@@")) {
			hasTrailingUnbalanced = true;
			break;
		}
	}
	if (!hasTrailingUnbalanced) return diff;
	if (lastAddIdx === -1) return "";
	return lines.slice(0, lastAddIdx + 1).join("\n");
}

type DisplaceableToolName = "job" | "todo";

function isTodoToolDetails(details: unknown): details is TodoToolDetails {
	return (
		typeof details === "object" &&
		details !== null &&
		"phases" in details &&
		Array.isArray((details as { phases?: unknown }).phases)
	);
}

function displaceableToolName(
	toolName: string,
	result: { details?: unknown; isError?: boolean },
	isPartial: boolean,
): DisplaceableToolName | undefined {
	if (result.isError === true) return undefined;
	if (toolName === "job" && isWaitingPollDetails(result.details)) return "job";
	if (toolName === "todo" && !isPartial && isTodoToolDetails(result.details)) return "todo";
	return undefined;
}

function stabilizeStreamingPreviews(previews: PerFileDiffPreview[]): PerFileDiffPreview[] {
	let changed = false;
	const next = previews.map(preview => {
		if (!preview.diff) return preview;
		const trimmed = stripTrailingUnbalancedRemoval(preview.diff);
		if (trimmed === preview.diff) return preview;
		changed = true;
		return { ...preview, diff: trimmed ?? "" };
	});
	return changed ? next : previews;
}

function isEditLikeToolName(toolName: string): boolean {
	return toolName === "edit" || toolName === "apply_patch";
}

function resolveEditModeForTool(toolName: string, tool: AnyAgentTool | undefined): EditMode | undefined {
	if (toolName === "apply_patch") return "apply_patch";
	if (toolName !== "edit") return undefined;
	return (tool as { mode?: EditMode } | undefined)?.mode;
}

function rawTextInputFromPartialJson(partialJson: unknown): string | undefined {
	if (typeof partialJson !== "string") return undefined;
	if (partialJson.length === 0) return undefined;
	const trimmed = partialJson.trimStart();
	if (trimmed.length === 0) return undefined;
	const first = trimmed[0];
	// Function-tool arguments stream as JSON. Custom/free-form tools stream raw
	// text in the same transport field; only the raw form is a valid fallback for
	// the conventional `input` parameter.
	if (first === "{" || first === '"') return undefined;
	return partialJson;
}

/** Read the streamed raw-JSON buffer a tool block stashes on its args, narrowed
 *  rather than cast: a missing or non-string `__partialJson` yields `undefined`. */
function partialJsonOf(args: unknown): string | undefined {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = args.__partialJson;
	return typeof value === "string" ? value : undefined;
}

function getArgsWithStreamedTextInput(args: unknown): unknown {
	if (args == null || typeof args !== "object") return args;
	const record = args as Record<string, unknown>;
	if (typeof record.input === "string") return args;
	const input = rawTextInputFromPartialJson(record.__partialJson);
	return input === undefined ? args : { ...record, input };
}

/**
 * Transcript-side probe telling a block whether it is still inside the live
 * (repaintable) region. Implemented by `TranscriptContainer`; injected rather
 * than imported so the component stays decoupled from the transcript.
 */
export interface TranscriptLiveRegionProbe {
	isBlockInLiveRegion(component: Component): boolean;
}

export interface ToolExecutionOptions {
	snapshots?: SnapshotStore;
	showImages?: boolean; // default: true (only used if terminal supports images)
	editFuzzyThreshold?: number;
	editAllowFuzzy?: boolean;
	/** Live-region probe used to settle detached task progress once the block
	 * leaves the repaintable transcript region. */
	liveRegion?: TranscriptLiveRegionProbe;
}

export interface ToolExecutionHandle extends Component {
	updateArgs(args: unknown, toolCallId?: string): void;
	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError?: boolean;
		},
		isPartial?: boolean,
		toolCallId?: string,
	): void;
	setArgsComplete(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
	/** Freeze the block as final history: stop spinners and let it commit to scrollback. */
	seal(): void;
}

/** Redraw live tool blocks at the spinner's glyph-advance rate. Rendering more
 * often produced identical frames — the previous 30fps cadence emitted ~2.4
 * paints per glyph step, and although the terminal I/O layer dedupes those, the
 * compose pipeline still ran end-to-end per frame (issue #4353). Matching the
 * render tick to the glyph tick halves the paints during tool execution with no
 * visible change. */
export const SPINNER_RENDER_INTERVAL_MS = 80;
/** Advance the spinner glyph at its classic ~12.5fps step (mirrors `Loader`). */
export const SPINNER_GLYPH_ADVANCE_MS = 80;

/** Phase-locked spinner glyph index shared by every live tool block so parallel
 * spinners advance in lockstep instead of each tracking its own start time. */
export function sharedSpinnerFrame(frameCount: number, now: number = performance.now()): number {
	return frameCount > 0 ? Math.floor(now / SPINNER_GLYPH_ADVANCE_MS) % frameCount : 0;
}

// Stable per-instance counter so each tool execution's inline images get a
// graphics id that survives child re-creation (the image budget keys off it).
let toolExecutionInstanceSeq = 0;

/**
 * The result a transcript rebuild gives a tool call whose TURN ended in an
 * error and which therefore has no result of its own.
 *
 * Four rebuild sites used to fabricate `{ content: [error text], isError: true }`
 * with no details at all, which says the TOOL failed. It did not: the turn did,
 * and the call never reached a tool. That bare shape is indistinguishable from a
 * command that ran and exited non-zero, so the operator got failure chrome, the
 * provider's error as the tool's own output, and no statement that nothing had
 * run, which is the one fact that mattered. Carrying the loop's own
 * `assistant_stop_error` discriminator makes the card render exactly like the
 * live path already does: the call, and one warning line naming the provider
 * error as the reason nothing ran.
 */
export function turnFailedToolResult(errorMessage: string): {
	content: Array<{ type: string; text: string }>;
	isError: true;
	details: SyntheticToolResultDetails;
} {
	return {
		content: [{ type: "text", text: errorMessage }],
		isError: true,
		details: { __synthetic: true, source: "assistant_stop_error", executed: false, upstreamError: errorMessage },
	};
}

/**
 * Why a tool call produced no work, in the operator's words.
 *
 * Three shapes reach the transcript and none of them used to say anything. The
 * loop synthesizes a placeholder result for a call the assistant emitted but
 * never dispatched, tagging it `__synthetic` with an `executed: false` and a
 * `source` naming the assistant-side stop (`agent-loop.ts`
 * `SyntheticToolResultDetails`, added by #4321 so that "UI, telemetry, and
 * history consumers can key on `__synthetic === true` to render or classify
 * these as 'call emitted, not executed' instead of a real local tool failure").
 * Nothing in the transcript ever read it, so those placeholders rendered with
 * the same red `failed` chrome as a command that ran and exited non-zero.
 *
 * The second is `__skipped`: a call an interrupt cut short. It is the same claim
 * as the first and was read here for the same reason, one release later, which
 * is the recurring shape of this defect: the branch gets written for the
 * discriminator someone had in mind and its sibling keeps rendering as a
 * failure. It is also by far the more common of the two.
 *
 * The third is a block the turn `seal()`ed with no result at all, which rendered
 * byte-identically to a call still in flight.
 */
function notExecutedReason(result: { details?: unknown } | undefined, sealed: boolean): string | undefined {
	if (result === undefined) {
		return sealed ? "no result recorded: this call was cut off before it reported back" : undefined;
	}
	const details = result.details;
	if (details == null || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	if (record.__skipped === true) {
		// A skip says two things and the second is the one that matters. `entered`
		// is whether control had crossed into the tool: false means nothing was
		// applied, true means the tool was running and may have left half its work
		// behind. Rendering both as one line would flatten the distinction the
		// placeholder exists to carry.
		return record.entered === true
			? "cut off while running: side effects may be partial"
			: "not executed: an interrupt cut the batch short before this call ran";
	}
	if (record.__synthetic !== true || record.executed !== false) return undefined;
	// The provider's own words, which are the only actionable fact in the whole card: "the stream
	// stalled while waiting for the next event" is what tells an operator this was a transport
	// failure and not their prompt. It used to reach the screen only inside the model-facing
	// placeholder text, wrapped across two rows of a red `failed` frame.
	//
	// ONCE PER BATCH, not once per call. The loop attaches the batch ledger to exactly one
	// placeholder in a cut-short batch, so that card is the one that names the fault and its
	// siblings say only that they did not run. A wide batch otherwise printed the same provider
	// sentence on every row, under a pinned turn error that had already said it, which is the
	// wall of yellow text this reads as. A lone dropped call still carries the ledger, so a
	// single-call batch keeps the full statement.
	const upstream = typeof record.upstreamError === "string" ? record.upstreamError.trim() : "";
	const detail = upstream.length > 0 && record.batchLedger !== undefined ? `: ${upstream}` : "";
	switch (record.source) {
		case "assistant_stop_aborted":
			return "not executed: the turn was interrupted before this call ran";
		case "assistant_stop_skipped":
			return "not executed: the assistant ended its turn before this call ran";
		case "assistant_stop_length":
			return "not executed: the assistant hit its output limit before the arguments finished";
		case "assistant_stop_error":
			return `not executed: the provider stream failed before this call ran${detail}`;
		default:
			return "not executed";
	}
}

/**
 * Whether this result is a placeholder for a call that never reached the tool.
 *
 * The card renders the CALL and nothing else when it is. The placeholder's text is written for the
 * model — "Tool call was not executed because the provider stream ended with an error before the
 * tool could run", and for a truncated one a paragraph telling the model to split its payload — and
 * putting it through the tool's own result renderer drew a red `✗ failed` frame around it, so a call
 * that touched nothing looked exactly like a command that ran and exited non-zero, with the reason
 * stated twice in two registers. {@link notExecutedReason} says it once, in the operator's words.
 *
 * The rule itself lives in {@link toolResultNeverRan}, next to the two placeholder shapes the agent
 * loop writes, because the session reads it too: it decides whether a failed turn is safe to discard
 * and replay. Two copies could disagree about whether work happened.
 */
function isNeverRanResult(result: { details?: unknown } | undefined): boolean {
	return toolResultNeverRan(result?.details);
}

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container implements NativeScrollbackLiveRegion {
	#contentBox: Box; // Used for custom tools and bash visual truncation
	#contentText: WidthAwareText; // Generic fallback (no custom/built-in renderer)
	#multiFileBoxes: (Box | Spacer)[] = []; // Extra boxes for multi-file edit results
	#imageComponents: Image[] = [];
	#imageSpacers: Spacer[] = [];
	/** The "this call did not run" line, when one applies. Managed like the image
	 *  children: removed and re-added by every rebuild rather than mutated. */
	#notExecutedNotice: Text | undefined;
	readonly #instanceId = ++toolExecutionInstanceSeq;
	#toolName: string;
	#toolLabel: string;
	#args: unknown;
	#expanded = false;
	#showImages: boolean;
	#editFuzzyThreshold: number | undefined;
	#editAllowFuzzy: boolean | undefined;
	#snapshots?: SnapshotStore;
	#isPartial = true;
	#resultVersion = 0;
	#lastDisplayKey: string | undefined;
	// Bumped whenever a render input that #rebuildDisplay consumes but the memo
	// key cannot cheaply hash changes: streamed call args, the async edit-diff
	// preview, and Kitty PNG conversions. Folded into the dirty key so those
	// updates are not swallowed by the memo (see #updateDisplay).
	#displayInputVersion = 0;
	// Set once #rebuildDisplay has populated the display. Replaces a
	// #contentBox.children.length probe so the memo fast-path also covers the
	// #contentText fallback path (which leaves #contentBox empty).
	#displayBuilt = false;
	// Number of Image children the last rebuild emitted. Only when this is > 0 does
	// the memo key fold in viewport-dependent image sizing (resolveImageOptions),
	// so a terminal resize re-shapes image-bearing results to rescale them without
	// forcing the common image-free result to re-shape on every resize tick.
	#renderedImageCount = 0;
	#tool?: AnyAgentTool;
	#ui: TUI;
	#cwd: string;
	#result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: unknown;
	};
	// Edit preview state
	#editMode?: EditMode;
	#editDiffPreview?: PerFileDiffPreview[];
	#editDiffAbort?: AbortController;
	#editDiffLastArgsKey?: string;
	// Latest in-flight streaming diff recompute, captured so it can be awaited.
	#editDiffInFlight?: Promise<void>;
	/** Set when newer args arrived while a preview compute was in flight; the
	 *  drain loop re-runs once the current compute settles, so a slow diff
	 *  coalesces streamed ticks instead of being aborted by each one. */
	#editDiffDirty = false;
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	#convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// Spinner animation for partial task results
	#spinnerFrame?: number;
	#spinnerInterval?: NodeJS.Timeout;
	// Todo write completion strikethrough reveal animation
	#todoStrikeInterval?: NodeJS.Timeout;
	// Track if args are still being streamed (for edit/write spinner)
	#argsComplete = false;
	// Sealed once the tool reaches a terminal state (result delivered, or the
	// turn abandoned it without one). Drives `isTranscriptBlockFinalized`: until
	// sealed the block stays in the transcript's repaintable live region so a
	// late result still repaints instead of stranding the streaming preview.
	#sealed = false;
	// Tool result snapshots that may be superseded by a later same-tool call
	// while still in the transcript live region. `job` uses this for repeated
	// all-running polls; `todo` uses it for per-turn state snapshots so only the
	// latest list remains visible.
	#displaceableByToolName: DisplaceableToolName | undefined;
	// Probe into the owning transcript (absent outside the interactive
	// transcript, e.g. in tests): whether this block is still repaintable.
	#liveRegion?: TranscriptLiveRegionProbe;
	// One-way latch for a detached (`async.state === "running"`) task block
	// that left the transcript live region: its rows are commit-eligible
	// history, so progress renders static gray and further partial snapshots are
	// dropped (see #maybeFreezeBackgroundTask).
	#backgroundTaskFrozen = false;
	// Set on each `render()` when the last painted pending shape must be
	// replayed wholesale when the first result arrives. Reset gates key off
	// these so a topology-changing update that lands before the shape reaches
	// the terminal never triggers a full-viewport replay (which on direct
	// terminals wipes native scrollback and flashes the user's history —
	// reviewer note on PR #4315).
	#firstResultViewportRepaintShapePainted = false;
	#partialResultShapePainted = false;
	#renderState: {
		spinnerFrame?: number;
		expanded: boolean;
		isPartial: boolean;
		renderContext?: Record<string, unknown>;
	} = {
		expanded: false,
		isPartial: true,
	};

	constructor(
		toolName: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		tool: AnyAgentTool | undefined,
		ui: TUI,
		cwd: string = getProjectDir(),
		_toolCallId?: string,
	) {
		super();
		this.#toolName = toolName;
		this.#toolLabel = tool?.label ?? toolName;
		this.#showImages = options.showImages ?? true;
		this.#editFuzzyThreshold = options.editFuzzyThreshold;
		this.#editAllowFuzzy = options.editAllowFuzzy;
		this.#snapshots = options.snapshots;
		this.#liveRegion = options.liveRegion;
		this.#tool = tool;
		this.#ui = ui;
		this.#cwd = cwd;
		this.#args = args;
		this.#editMode = resolveEditModeForTool(toolName, tool);

		// Always create both - contentBox for custom tools/bash/tools with renderers, contentText for other built-ins.
		// paddingY is 1 so background-tinted blocks (custom/extension tools and the
		// generic fallback) get top/bottom breathing room. TranscriptContainer
		// strips PLAIN-blank edges, so framed/minimal blocks (no bg set) drop these
		// lines and keep their tight spacing — only tinted lines survive.
		// The transcript's one left rail: the card's frame starts where the composer
		// gutter and every other block start. A card at column 0 beside inset blocks
		// reads as a misalignment, which is why the design language says nothing sits
		// at column 0 (docs/internal/tui-design-language.md).
		this.#contentBox = new Box(COMPOSER_INSET_COLS, 1);
		this.#contentText = new WidthAwareText(contentWidth => this.#formatToolExecution(contentWidth), 1, 1);

		// Use Box for custom tools or built-in tools that have renderers
		const hasRenderer = toolName in toolRenderers;
		const hasCustomRenderer = !!(tool?.renderCall || tool?.renderResult);
		if (hasCustomRenderer || hasRenderer) {
			this.addChild(this.#contentBox);
		} else {
			this.addChild(this.#contentText);
		}
		// Tool blocks are visually distinct cards (background-tinted or framed),
		// so keep their horizontal padding even when the user enables tight layout.
		this.setIgnoreTight(true);

		this.#updateSpinnerAnimation();
		this.#updateDisplay();
		this.#schedulePreviewDiff();
	}

	updateArgs(args: unknown, _toolCallId?: string): void {
		// Reference-equality short-circuit before any further work. Callers
		// always allocate a new arg object on each streamed delta (see
		// event-controller.ts and ui-helpers.ts), so a same-reference assignment
		// signals "nothing meaningful changed" and the renderer can skip.
		if (args === this.#args) return;
		this.#args = args;
		this.#displayInputVersion++;
		this.#updateSpinnerAnimation();
		this.#schedulePreviewDiff();
		this.#updateDisplay();
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers an immediate final diff computation for edit-like tools.
	 */
	setArgsComplete(_toolCallId?: string): void {
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		this.#schedulePreviewDiff();
	}

	/**
	 * Await the streaming diff recompute kicked off by the most recent
	 * `updateArgs`/`setArgsComplete`. The recompute reads the file and re-runs the
	 * whole-file Myers diff off the render path, signalling completion only via a
	 * throttled `requestRender`. Tests await this to sample a *settled* preview
	 * deterministically instead of racing the spinner's render ticks.
	 */
	async whenPreviewSettled(): Promise<void> {
		await this.#editDiffInFlight;
	}

	/**
	 * Schedule a streaming diff preview recompute, coalescing bursts of
	 * `updateArgs` into one compute at a time: run the current compute to
	 * completion and re-run only after it settles when newer args arrived, never
	 * cancelling an in-flight compute on a fresh tick. The reveal controller pushes
	 * args ~30fps and a whole-file hashline/large-file diff can outlast a frame, so
	 * cancel-per-tick would starve every compute and no preview would land until
	 * args complete. Coalescing lets each diff land, so the preview tracks the
	 * stream at the rate the diffs can sustain.
	 */
	#schedulePreviewDiff(): void {
		this.#editDiffDirty = true;
		if (this.#editDiffInFlight) return;
		this.#editDiffInFlight = this.#drainPreviewDiff().finally(() => {
			this.#editDiffInFlight = undefined;
		});
	}

	async #drainPreviewDiff(): Promise<void> {
		while (this.#editDiffDirty) {
			this.#editDiffDirty = false;
			await this.#computePreviewDiff();
		}
	}

	async #computePreviewDiff(): Promise<void> {
		const editMode = this.#editMode;
		if (!editMode) return;
		const strategy = EDIT_MODE_STRATEGIES[editMode];
		if (!strategy) return;

		const args = this.#args;
		if (args == null || typeof args !== "object") return;

		const previewArgs = getArgsWithStreamedTextInput(args);
		const partialJson = partialJsonOf(previewArgs);
		let effectiveArgs: unknown;
		try {
			effectiveArgs = strategy.extractCompleteEdits(previewArgs, partialJson);
		} catch {
			effectiveArgs = previewArgs;
		}

		// Coalesce duplicate computes for identical args. The key pairs the
		// streaming flag with a content hash: the final (args-complete) pass
		// computes an untrimmed diff and must run even when the payload is
		// byte-identical to the last streamed chunk — only `isStreaming` differs,
		// and it flips the trailing-line trim. Without the flag a single-line edit
		// whose trailing payload line never gets a newline stays stuck on the
		// trimmed "no changes" streaming preview and renders no diff. Hashing keeps
		// the retained key tiny instead of holding the whole serialized blob.
		const streamingState = this.#argsComplete ? "final" : "stream";
		let argsKey: string;
		try {
			argsKey = `${streamingState}:${Bun.hash(JSON.stringify(effectiveArgs))}`;
		} catch {
			// effectiveArgs isn't JSON-serializable (exotic value in tool args).
			// The raw streamed JSON is a plain string, so hash that instead of a
			// timestamp — a deterministic key keeps the dedup cache working
			// instead of recomputing (and re-reading the file) on every render.
			argsKey = `${streamingState}:partial:${Bun.hash(partialJson ?? "")}`;
		}
		if (argsKey === this.#editDiffLastArgsKey) return;
		this.#editDiffLastArgsKey = argsKey;

		// Single-flight (the drain loop never overlaps computes), so this controller
		// only ever cancels the live compute on teardown via `stopAnimation`.
		const controller = new AbortController();
		this.#editDiffAbort = controller;

		try {
			const isStreaming = !this.#argsComplete;
			if (editMode === "hashline" && !this.#snapshots) return;
			const previews = await strategy.computeDiffPreview(effectiveArgs, {
				cwd: this.#cwd,
				signal: controller.signal,
				snapshots: this.#snapshots!,
				fuzzyThreshold: this.#editFuzzyThreshold,
				allowFuzzy: this.#editAllowFuzzy,
				isStreaming,
			});
			if (controller.signal.aborted) return;
			if (previews) {
				this.#editDiffPreview = isStreaming ? stabilizeStreamingPreviews(previews) : previews;
				this.#displayInputVersion++;
				this.#updateDisplay();
				this.#ui.requestRender();
			}
		} catch (err) {
			if (controller.signal.aborted) return;
			logger.warn("Edit preview diff failed", { tool: this.#toolName, error: String(err) });
		}
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError?: boolean;
		},
		isPartial = false,
		_toolCallId?: string,
	): void {
		// A detached task spawn keeps streaming progress snapshots after the
		// block froze (left the transcript live region). Drop them: the rows are
		// static gray history now, and repainting would rewrite rows the engine
		// may already have committed to native scrollback. The terminal snapshot
		// (async completed/failed → isPartial=false) still applies so a block
		// that is still on screen settles on real results.
		if (isPartial && this.#toolName === "task" && this.#maybeFreezeBackgroundTask()) {
			return;
		}
		const hadNoResult = this.#result === undefined;
		const wasPartialResult = this.#result !== undefined && this.#isPartial;
		const firstResultRepaintShapePainted = this.#firstResultViewportRepaintShapePainted;
		const partialResultPainted = this.#partialResultShapePainted;
		this.#firstResultViewportRepaintShapePainted = false;
		this.#partialResultShapePainted = false;
		this.#result = result;
		this.#resultVersion++;
		this.#isPartial = isPartial;
		this.#displaceableByToolName = displaceableToolName(this.#toolName, result, isPartial);
		// When tool is complete, ensure args are marked complete so spinner stops
		if (!isPartial) {
			this.#argsComplete = true;
		}
		this.#updateSpinnerAnimation();
		this.#updateTodoStrikeAnimation();
		this.#updateDisplay();
		this.#resetDisplayForResultTopologyChange(
			hadNoResult && firstResultRepaintShapePainted,
			wasPartialResult && partialResultPainted,
			isPartial,
		);
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.#maybeConvertImagesForKitty();
	}

	/**
	 * Get all image blocks from result content and details.images.
	 * Some tools (like generate_image) store images in details to avoid bloating model context.
	 */
	#getAllImageBlocks(): Array<{ data?: string; mimeType?: string }> {
		if (!this.#result) return [];
		const contentImages = this.#result.content?.filter(c => c.type === "image") || [];
		const detailImages =
			(this.#result.details as { images?: Array<{ data?: string; mimeType?: string }> } | undefined)?.images || [];
		return [...contentImages, ...detailImages];
	}

	/**
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	#maybeConvertImagesForKitty(): void {
		// Only needed for Kitty protocol
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		if (!this.#result) return;

		const imageBlocks = this.#getAllImageBlocks();

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.#convertedImages.has(i)) continue;

			// Convert async - catch errors from processing
			const index = i;
			new Bun.Image(Buffer.from(img.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#convertedImages.set(index, { data, mimeType: "image/png" });
					this.#displayInputVersion++;
					this.#updateDisplay();
					this.#ui.requestRender();
				})
				.catch(() => {
					// Ignore conversion failures - display will use original image format
				});
		}
	}

	/**
	 * Start or stop spinner animation for live states that visibly tick.
	 */
	#updateSpinnerAnimation(): void {
		// Live partial tool blocks stay repaintable until a terminal result seals
		// them. Todo snapshots and detached background tool progress are deliberate
		// static exceptions because their rows can be superseded or committed to
		// scrollback while later updates continue elsewhere.
		const isStreamingArgs = !this.#argsComplete && (isEditLikeToolName(this.#toolName) || this.#toolName === "write");
		const isBackgroundAsyncRunning =
			(this.#result?.details as { async?: { state?: string } } | undefined)?.async?.state === "running";
		const renderer = toolRenderers[this.#toolName] as
			| {
					animatedPendingPreview?: boolean | ((args: unknown) => boolean);
					animatedPartialResult?: boolean | ((args: unknown) => boolean);
			  }
			| undefined;
		const pendingAnimation = renderer?.animatedPendingPreview;
		const partialAnimation = renderer?.animatedPartialResult;
		const pendingCallConsumesSpinner =
			this.#result === undefined &&
			(renderer === undefined
				? // Only the generic #formatToolExecution fallback consumes the frame;
					// a custom renderCall/renderResult pair routes through the custom
					// branch whose pending label is a static tool-name Text.
					!this.#tool?.renderCall && !this.#tool?.renderResult
				: typeof pendingAnimation === "function"
					? pendingAnimation(this.#args)
					: pendingAnimation === true);
		const partialResultConsumesSpinner =
			this.#result !== undefined &&
			(renderer === undefined
				? !this.#tool?.renderCall && !this.#tool?.renderResult
				: typeof partialAnimation === "function"
					? partialAnimation(this.#args)
					: partialAnimation === true);
		const isLivePartialTool =
			this.#isPartial &&
			this.#toolName !== "todo" &&
			!isBackgroundAsyncRunning &&
			(pendingCallConsumesSpinner || partialResultConsumesSpinner);
		const needsSpinner = isStreamingArgs || isLivePartialTool || this.#displaceableByToolName === "job";
		if (needsSpinner && !this.#spinnerInterval) {
			const frameCount = theme.spinnerFrames.length;
			const frame = sharedSpinnerFrame(frameCount);
			this.#spinnerFrame = frame;
			this.#renderState.spinnerFrame = frame;
			this.#spinnerInterval = setInterval(() => {
				// If a detached task interval from an older render path is still live,
				// stop it the instant the block leaves the repaintable region.
				if (this.#maybeFreezeBackgroundTask()) return;
				const now = performance.now();
				// The active theme is a live module binding, read fresh each tick so a theme switch takes
				// effect mid-spin. It is normally a Theme by the time anything renders, and if it is not,
				// this tick must not be where that is discovered 12 times a second: a throw inside a timer
				// callback has no handler, so it surfaces as an unhandled error attributed to whatever is
				// running at the time -- which is how one missing theme cost 12 failures in three unrelated
				// suites. Stop the animation and say so instead, loudly and once.
				if (!Array.isArray(theme?.spinnerFrames)) {
					logger.warn("Spinner stopped: the active theme has no spinner frames", {
						tool: this.#toolName,
						theme: theme === undefined ? "unset" : "no spinnerFrames",
					});
					this.stopAnimation();
					return;
				}
				const frameCount = theme.spinnerFrames.length;
				this.#spinnerFrame = sharedSpinnerFrame(frameCount, now);
				this.#renderState.spinnerFrame = this.#spinnerFrame;
				// Component-scoped: a spinner tick only changes this tool block, so
				// the TUI reuses every other root subtree instead of walking the
				// whole tree (issue #4377).
				this.#requestScopedRender();
			}, SPINNER_RENDER_INTERVAL_MS);
		} else if (!needsSpinner && this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
			// Clear the last drawn frame so a non-live renderCall (e.g. a write whose
			// args just completed) stops showing a frozen spinner glyph. Skip when a
			// todo strike owns the frame — it sets its own value right after this.
			if (!this.#todoStrikeInterval) {
				this.#spinnerFrame = undefined;
				this.#renderState.spinnerFrame = undefined;
			}
		}
	}

	/**
	 * Freeze a detached (`async.state === "running"`) task block once it leaves
	 * the transcript's live region. Past that seam its rows are commit-eligible
	 * native-scrollback history: repaint the progress rows static gray and drop
	 * further partial snapshots. One-way — blocks never re-enter the live
	 * region. Returns whether the block is frozen.
	 */
	#maybeFreezeBackgroundTask(): boolean {
		if (this.#backgroundTaskFrozen) return true;
		if (this.#toolName !== "task" || this.#liveRegion === undefined) return false;
		const asyncState = (this.#result?.details as { async?: { state?: string } } | undefined)?.async?.state;
		if (asyncState !== "running") return false;
		if (this.#liveRegion.isBlockInLiveRegion(this)) return false;
		this.#backgroundTaskFrozen = true;
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
		this.#requestScopedRender();
		return true;
	}

	#updateTodoStrikeAnimation(): void {
		if (this.#toolName !== "todo" || this.#isPartial || this.#result?.isError) {
			this.#stopTodoStrikeAnimation();
			return;
		}
		const completedTasks = (this.#result?.details as { completedTasks?: unknown[] } | undefined)?.completedTasks;
		if (!completedTasks || completedTasks.length === 0) {
			this.#stopTodoStrikeAnimation();
			return;
		}
		if (this.#todoStrikeInterval) return;

		this.#spinnerFrame = 0;
		this.#renderState.spinnerFrame = 0;
		this.#todoStrikeInterval = setInterval(() => {
			const nextFrame = (this.#spinnerFrame ?? 0) + 1;
			if (nextFrame > TODO_STRIKE_TOTAL_FRAMES) {
				this.#stopTodoStrikeAnimation();
			} else {
				this.#spinnerFrame = nextFrame;
				this.#renderState.spinnerFrame = nextFrame;
			}
			// Component-scoped: strike animation only mutates this tool block's
			// glyph, so the TUI reuses every other root subtree (issue #4377).
			this.#requestScopedRender();
		}, 65);
	}

	#stopTodoStrikeAnimation(): void {
		if (this.#todoStrikeInterval) {
			clearInterval(this.#todoStrikeInterval);
			this.#todoStrikeInterval = undefined;
		}
		if (!this.#spinnerInterval) {
			this.#spinnerFrame = undefined;
			this.#renderState.spinnerFrame = undefined;
		}
	}

	/**
	 * Standalone harnesses may mount a tool component directly under `TUI`
	 * instead of inside `TranscriptContainer`. In that shape the component must
	 * report its own live-region seam while unfinalized, or the core renderer
	 * treats it like shell output and commits still-mutating preview rows to
	 * immutable native scrollback before the result replaces them.
	 */
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.isTranscriptBlockFinalized() ? undefined : 0;
	}

	/**
	 * Whether this block has reached a terminal state for transcript freezing.
	 * Reports `false` while it can still visually change so the
	 * {@link TranscriptContainer} keeps it inside the repaintable live region:
	 * a foreground tool awaiting its result, or one streaming partial output.
	 * A final (non-partial) result, a background-async tool the agent has moved
	 * past, or an explicit {@link seal} flips it to `true`.
	 */
	isTranscriptBlockFinalized(): boolean {
		if (this.#sealed) return true;
		if (this.#result === undefined) return false;
		// A displaceable snapshot stays live: its rows are kept out of native
		// scrollback so a follow-up tool call can remove the block.
		if (this.#displaceableByToolName) return false;
		if (!this.#isPartial) return true;
		// Partial result: a background async tool is accepted to freeze (the agent
		// continues while it runs and would otherwise pin an unbounded live region);
		// a foreground tool streaming partial output stays live until it finishes.
		return (this.#result.details as { async?: { state?: string } } | undefined)?.async?.state === "running";
	}

	/**
	 * Prefer component-scoped repaint (P3). Fall back to full-tree `requestRender`
	 * for minimal TUI stubs that omit `requestComponentRender`.
	 */
	#requestScopedRender(): void {
		if (typeof this.#ui.requestComponentRender === "function") {
			this.#ui.requestComponentRender(this);
			return;
		}
		this.#ui.requestRender();
	}

	/**
	 * Mark the tool terminal even though no result arrived (the turn aborted or
	 * abandoned it) and stop animating, so it can freeze and stops pinning the
	 * transcript live region.
	 */
	seal(): void {
		if (this.#sealed) return;
		this.#sealed = true;
		this.#displaceableByToolName = undefined;
		// A sealed detached task is abandoned history: settle its progress rows
		// on static gray.
		this.#backgroundTaskFrozen = true;
		this.stopAnimation();
		this.#updateDisplay();
		this.#requestScopedRender();
	}

	/**
	 * Whether this block is a supersedable result snapshot that has not been
	 * sealed. Such a block never finalized, so none of its rows entered native
	 * scrollback and the whole block can be removed when a follow-up matching
	 * tool call supersedes it.
	 */
	isDisplaceableBlock(): boolean {
		return this.#displaceableByToolName !== undefined && !this.#sealed;
	}

	canBeDisplacedBy(nextToolName: string | undefined): boolean {
		return (
			this.#displaceableByToolName !== undefined && this.#displaceableByToolName === nextToolName && !this.#sealed
		);
	}

	/**
	 * Stop spinner animation and cleanup resources.
	 */
	stopAnimation(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
			this.#spinnerFrame = undefined;
			this.#renderState.spinnerFrame = undefined;
		}
		this.#stopTodoStrikeAnimation();
		this.#editDiffAbort?.abort();
		this.#editDiffAbort = undefined;
		// Drop any queued rerun so the drain loop exits instead of recomputing a
		// preview for a torn-down block after its in-flight compute is aborted.
		this.#editDiffDirty = false;
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.#showImages = show;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		// `TERMINAL.imageProtocol` is resolved by an async capability probe during
		// TUI startup, so a result rendered before it lands must re-shape once it
		// does (it gates Image children vs text fallback in #rebuildDisplay); keyed
		// here for the same reason markdown.ts keys its render cache on it.
		// `#sealed` is in the key in its own right: a block sealed with no result gains
		// the "no result recorded" notice, and `#backgroundTaskFrozen` (which `seal()`
		// also sets) is not a substitute because `#maybeFreezeBackgroundTask` sets that
		// one on its own for a detached task that is still going to report.
		const key = `${this.#resultVersion}|${this.#expanded}|${this.#isPartial}|${this.#spinnerFrame ?? "-"}|${this.#showImages}|${getThemeEpoch()}|${this.#displayInputVersion}|${this.#backgroundTaskFrozen}|${this.#sealed}|${TERMINAL.imageProtocol ?? "-"}|${this.#imageSizeKey()}`;
		if (key === this.#lastDisplayKey && this.#displayBuilt) return;
		this.#lastDisplayKey = key;

		this.#rebuildDisplay();
		this.#displayBuilt = true;
	}

	#rendererFlag(name: "forceResultViewportRepaintOnSettle"): boolean {
		const toolValue = (this.#tool as Record<string, unknown> | undefined)?.[name];
		const rendererValue = toolRenderers[this.#toolName]?.[name];
		return toolValue === true || (toolValue === undefined && rendererValue === true);
	}

	/**
	 * True while the last painted pending-call shape opted into a full viewport
	 * repaint at the first result (`forceFirstResultViewportRepaint`) — e.g. the
	 * streamed SSH placeholder (`⏳ SSH: […]` / `$ …`) or a collapsed write tail
	 * window, both of which the first result render re-anchors instead of
	 * preserving. Kept as a per-paint fact so a topology-changing update that
	 * lands before the pending rows reach the terminal skips the reset.
	 */
	#needsFirstResultViewportRepaintAtRender(): boolean {
		if (this.#result !== undefined) return false;
		const toolValue = (this.#tool as { forceFirstResultViewportRepaint?: FirstResultViewportRepaint } | undefined)
			?.forceFirstResultViewportRepaint;
		const value =
			toolValue !== undefined ? toolValue : toolRenderers[this.#toolName]?.forceFirstResultViewportRepaint;
		if (typeof value === "function") return value(this.#args, this.#renderState);
		return value === true;
	}

	#resetDisplayForResultTopologyChange(
		firstResultAfterRepaintShapePaint: boolean,
		partialResultPaintedBeforeSettle: boolean,
		isPartial: boolean,
	): void {
		const provisionalResultSettled =
			partialResultPaintedBeforeSettle && !isPartial && this.#rendererFlag("forceResultViewportRepaintOnSettle");
		if (firstResultAfterRepaintShapePaint || provisionalResultSettled) {
			this.#ui.resetDisplay();
		}
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		// Update the paint-tracking flags after `super.render(width)` — the
		// override runs on every compose the parent Container performs, so a
		// frame that never gets composed leaves the flags false and prevents a
		// spurious `resetDisplay()`.
		this.#firstResultViewportRepaintShapePainted = this.#needsFirstResultViewportRepaintAtRender();
		this.#partialResultShapePainted = this.#result !== undefined && this.#isPartial;
		return lines;
	}

	// Viewport-/settings-dependent image sizing folded into the memo key only when
	// the last rebuild actually emitted images, so a terminal resize re-shapes an
	// image-bearing result (to rescale it) without re-shaping every image-free
	// result on each resize tick.
	#imageSizeKey(): string {
		if (this.#renderedImageCount === 0) return "-";
		const o = resolveImageOptions();
		return `${o.maxWidthCells}:${o.maxHeightCells ?? "-"}`;
	}

	#rebuildDisplay(): void {
		// Sync shared mutable render state for component closures
		this.#renderState.expanded = this.#expanded;
		this.#renderState.isPartial = this.#isPartial;
		this.#renderState.spinnerFrame = this.#spinnerFrame;
		// A call that never reached the tool has no result to render, only a reason, and the reason
		// is the notice under the card. Every branch below therefore renders as though the result had
		// not arrived: the card shows the CALL the assistant asked for, which is the one fact the
		// notice cannot carry, and nothing paints failure chrome around a tool that did nothing.
		const neverRan = isNeverRanResult(this.#result);
		const renderableResult = neverRan ? undefined : this.#result;

		// Check for custom tool rendering
		if (this.#tool && (this.#tool.renderCall || this.#tool.renderResult)) {
			const tool = this.#tool;
			const mergeCallAndResult = Boolean((tool as { mergeCallAndResult?: boolean }).mergeCallAndResult);
			// Custom tools use Box for flexible component rendering
			this.#contentBox.setBgFn(undefined);
			this.#contentBox.clear();
			// Mirror the built-in renderer branch so custom renderers (notably the
			// task tool, whose live instance routes through here) receive the same
			// render context — e.g. the `hasResult` flag that suppresses the task
			// call preview once result lines exist.
			this.#renderState.renderContext = this.#buildRenderContext();

			// Render call component. The fallback label only stands in for a
			// missing `renderCall`; when the call is intentionally suppressed
			// (mergeCallAndResult once a result exists) we render nothing here so
			// the result component isn't preceded by a redundant tool-name line.
			//
			// A renderer whose call render IS a live widget (`callIsLiveWidget`, today only `ask`,
			// which paints the whole selectable question there) falls back to the plain label when
			// the call never ran: painting it puts an answerable question on screen for a question
			// that was never asked, which is the ghost this component's own suite exists to prevent.
			// A command or diff preview is NOT suppressed, because in that state the call is the one
			// fact the card has left to show.
			const suppressMergedWidget = neverRan && Boolean((tool as { callIsLiveWidget?: boolean }).callIsLiveWidget);
			const shouldRenderCall = !renderableResult || !mergeCallAndResult;
			if (shouldRenderCall) {
				if (tool.renderCall && !suppressMergedWidget) {
					try {
						const callArgs = this.#getCallArgsForRender();
						const callComponent = tool.renderCall(callArgs, this.#renderState, theme);
						if (callComponent) this.#contentBox.addChild(callComponent as Component);
					} catch (err) {
						this.#contentBox.addChild(
							reportRendererFailure(this.#rendererSubject("call"), err, "showing the tool name only"),
						);
						this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
					}
				} else {
					// No custom renderCall, show tool name
					this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
				}
			}

			// Render result component if we have a result
			if (renderableResult && tool.renderResult) {
				try {
					const renderResult = tool.renderResult as (
						result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
						options: { expanded: boolean; isPartial: boolean; spinnerFrame?: number },
						theme: Theme,
						args?: unknown,
					) => Component;
					const resultComponent = renderResult(
						{
							content: renderableResult.content,
							details: renderableResult.details,
							isError: renderableResult.isError,
						},
						this.#renderState,
						theme,
						this.#args,
					);
					if (resultComponent) this.#contentBox.addChild(resultComponent);
				} catch (err) {
					const output = this.#getTextOutput();
					this.#contentBox.addChild(
						reportRendererFailure(
							this.#rendererSubject("result"),
							err,
							output ? "showing raw output" : "there is no raw output to show instead",
						),
					);
					if (output) {
						this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
					}
				}
			} else if (renderableResult) {
				// Has result but no custom renderResult
				const output = this.#getTextOutput();
				if (output) {
					this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
				}
			}
			// Custom tools that draw their own frame (task) render flush; plain
			// extension renderers keep the padded block. No background is painted
			// either way: the terminal's own ground is the ground (slab class fix).
			// Self-framing custom renderers used to render flush at column 0 while
			// everything around them sat on the rail. Both cases take the rail now; the
			// frame is what makes a card a card, and where it starts is not the frame's
			// business.
			this.#contentBox.setPaddingX(COMPOSER_INSET_COLS);
			this.#contentBox.setBgFn(undefined);
		} else if (this.#toolName in toolRenderers) {
			// Built-in tools with renderers
			const renderer = toolRenderers[this.#toolName];

			// Clean up previous multi-file boxes
			for (const box of this.#multiFileBoxes) {
				this.removeChild(box);
			}
			this.#multiFileBoxes = [];

			// Check for multi-file edit results
			const perFileResults = (
				renderableResult?.details as { perFileResults?: Array<{ path: string; isError?: boolean }> } | undefined
			)?.perFileResults;
			if (perFileResults && perFileResults.length > 1) {
				// Multi-file: render each file as its own Box (identical to separate tool calls)
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				for (let i = 0; i < perFileResults.length; i++) {
					const fileResult = perFileResults[i];
					if (i > 0) {
						const spacer = new Spacer(1);
						this.#multiFileBoxes.push(spacer);
						this.addChild(spacer);
					}
					const fileBox = new Box(COMPOSER_INSET_COLS, 0);
					try {
						const resultComponent = renderer.renderResult(
							{ content: [], details: fileResult, isError: fileResult.isError },
							this.#renderState,
							theme,
						);
						if (resultComponent) fileBox.addChild(resultComponent);
					} catch (err) {
						// Without this row the file's box renders empty, which reads as
						// "this file produced no result" rather than "the renderer broke".
						fileBox.addChild(
							reportRendererFailure(
								this.#rendererSubject("result"),
								err,
								`no result is shown for ${fileResult.path}`,
							),
						);
					}
					this.#multiFileBoxes.push(fileBox);
					this.addChild(fileBox);
				}

				// Show pending indicator for remaining files
				const argEdits = (this.#args as { edits?: Array<{ path?: unknown }> } | undefined)?.edits;
				const totalFiles = argEdits ? new Set(argEdits.map(e => e?.path).filter(Boolean)).size : 0;
				const remaining = Math.max(0, totalFiles - perFileResults.length);
				if (remaining > 0 && this.#isPartial) {
					const pendingSpacer = new Spacer(1);
					this.#multiFileBoxes.push(pendingSpacer);
					this.addChild(pendingSpacer);
					const pendingBox = new Box(COMPOSER_INSET_COLS, 0);
					const spinner =
						this.#spinnerFrame !== undefined ? formatStatusIcon("running", theme, this.#spinnerFrame) : "";
					const pendingText = renderStatusLine(
						{
							iconOverride: spinner,
							title: "Edit",
							description: theme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						theme,
					);
					pendingBox.addChild(new Text(pendingText, 0, 0));
					this.#multiFileBoxes.push(pendingBox);
					this.addChild(pendingBox);
				}
			} else {
				// Single-file or no result: standard rendering
				// Inline renderers skip background styling
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				// Same rule as the custom-tool branch above: a call render that IS a live widget
				// (`callIsLiveWidget`) is replaced by the plain label once the call is known never to
				// have run, so an unasked question is not left looking answerable.
				const suppressMergedWidget = neverRan && Boolean(renderer.callIsLiveWidget);
				const shouldRenderCall = !renderableResult || !renderer.mergeCallAndResult;
				if (shouldRenderCall) {
					if (suppressMergedWidget) {
						this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
					} else {
						// Render call component
						try {
							const callArgs = this.#getCallArgsForRender();
							const callComponent = renderer.renderCall(callArgs, this.#renderState, theme);
							if (callComponent) this.#contentBox.addChild(callComponent);
						} catch (err) {
							this.#contentBox.addChild(
								reportRendererFailure(this.#rendererSubject("call"), err, "showing the tool name only"),
							);
							this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
						}
					}
				}

				// Render result component if we have a result
				if (renderableResult) {
					try {
						const resultComponent = renderer.renderResult(
							{
								content: renderableResult.content,
								details: renderableResult.details,
								isError: renderableResult.isError,
							},
							this.#renderState,
							theme,
							this.#getCallArgsForRender(),
						);
						if (resultComponent) this.#contentBox.addChild(resultComponent);
					} catch (err) {
						const output = this.#getTextOutput();
						this.#contentBox.addChild(
							reportRendererFailure(
								this.#rendererSubject("result"),
								err,
								output ? "showing raw output" : "there is no raw output to show instead",
							),
						);
						if (output) {
							this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
						}
					}
				}
			}
		} else {
			// Generic fallback (no custom/built-in renderer). WidthAwareText
			// reformats at render time so output fills the actual terminal width
			// instead of a fixed column cap.
			this.#contentText.setCustomBgFn(undefined);
			this.#contentText.invalidate();
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.#imageComponents) {
			this.removeChild(img);
		}
		this.#imageComponents = [];
		for (const spacer of this.#imageSpacers) {
			this.removeChild(spacer);
		}
		this.#imageSpacers = [];

		if (this.#result) {
			const imageBlocks = this.#getAllImageBlocks();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (TERMINAL.imageProtocol && this.#showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.#convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
					if (TERMINAL.imageProtocol === ImageProtocol.Kitty && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.#imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ ...resolveImageOptions(), budget: this.#ui.imageBudget, imageKey: `te${this.#instanceId}:${i}` },
					);
					this.#imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		// The "did not run" line, appended under the card so it reads as a note on the
		// block above it rather than a second title. Re-created each rebuild, on the
		// same remove-then-add discipline as the images.
		if (this.#notExecutedNotice) {
			this.removeChild(this.#notExecutedNotice);
			this.#notExecutedNotice = undefined;
		}
		const reason = notExecutedReason(this.#result, this.#sealed);
		if (reason !== undefined) {
			this.#notExecutedNotice = new Text(
				theme.fg("warning", `${theme.status.warning} ${reason}`),
				COMPOSER_INSET_COLS,
				0,
			);
			this.addChild(this.#notExecutedNotice);
		}
		this.#renderedImageCount = this.#imageComponents.length;
	}

	/**
	 * Reader-facing name for whichever half of this tool's renderer threw, so the
	 * transcript notice says which tool and which phase rather than just "a
	 * renderer". `renderCall` and `renderResult` fail independently and for
	 * different reasons, and knowing which one is most of the debugging.
	 */
	#rendererSubject(phase: "call" | "result"): string {
		return `tool "${this.#toolName}" ${phase}`;
	}

	#getCallArgsForRender(): unknown {
		const renderArgs = getArgsWithStreamedTextInput(this.#args);
		if (!isEditLikeToolName(this.#toolName)) {
			return renderArgs;
		}
		const previews = this.#editDiffPreview;
		if (!previews || previews.length === 0) {
			return renderArgs;
		}
		// Single-file previews feed the existing `previewDiff` channel consumed
		// by `formatStreamingDiff` in the renderer.
		const first = previews[0];
		if (!first?.diff) {
			return renderArgs;
		}
		return { ...(renderArgs as Record<string, unknown>), previewDiff: first.diff };
	}

	/**
	 * Build render context for tools that need extra state (bash, python, edit)
	 */
	#buildRenderContext(): Record<string, unknown> {
		const context: Record<string, unknown> = {};
		const normalizeTimeoutSeconds = (value: unknown, maxSeconds: number): number | undefined => {
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			return clampLow(value, 1, maxSeconds);
		};

		if (this.#toolName === "bash") {
			// Bash needs render context even before a result exists. The renderer uses the pending-call args
			// plus this context to keep the inline command preview visible while tool-call JSON is still streaming.
			if (this.#result) {
				// Pass raw output and expanded state - renderer handles width-aware truncation
				const output = this.#getTextOutput().trimEnd();
				context.output = output;
			}
			context.expanded = this.#expanded;
			context.previewLines = BASH_DEFAULT_PREVIEW_LINES;
			context.timeout = normalizeTimeoutSeconds((this.#args as { timeout?: unknown } | undefined)?.timeout, 3600);
		} else if (this.#toolName === "eval" && this.#result) {
			const output = this.#getTextOutput().trimEnd();
			context.output = output;
			context.expanded = this.#expanded;
			context.previewLines = EVAL_DEFAULT_PREVIEW_LINES;
		} else if (this.#toolName === "task") {
			// Once a result snapshot exists the task renderer's `renderResult`
			// draws every dispatched agent as a progress/result line, so tell
			// `renderCall` to drop its duplicate streaming preview list.
			context.hasResult = Boolean(this.#result);
			// Out of the transcript live region: progress rows render static gray
			// (see task/render.ts).
			context.frozen = this.#backgroundTaskFrozen;
		} else if (isEditLikeToolName(this.#toolName)) {
			context.editMode = this.#editMode;
			const previews = this.#editDiffPreview;
			if (previews && previews.length > 0) {
				const first = previews[0];
				if (first?.diff || first?.error) {
					context.editDiffPreview = first.error
						? { error: first.error }
						: { diff: first.diff ?? "", firstChangedLine: first.firstChangedLine };
				}
				if (previews.length > 1) {
					context.perFileDiffPreview = previews;
				}
			}
			if (!previews?.some(preview => preview.diff)) {
				const editMode = this.#editMode;
				const strategy = editMode ? EDIT_MODE_STRATEGIES[editMode] : undefined;
				const fallback = strategy?.renderStreamingFallback(getArgsWithStreamedTextInput(this.#args), theme);
				if (fallback) context.editStreamingFallback = fallback;
			}
			context.renderDiff = renderDiff;
		}

		return context;
	}

	#getTextOutput(): string {
		if (!this.#result) return "";

		const textBlocks = this.#result.content?.filter(c => c.type === "text") || [];
		const imageBlocks = this.#getAllImageBlocks();

		let output = textBlocks.map(c => sanitizeWithOptionalSixelPassthrough(c.text || "", sanitizeText)).join("\n");

		if (imageBlocks.length > 0 && (!TERMINAL.imageProtocol || !this.#showImages)) {
			const imageIndicators = imageBlocks
				.map(img => {
					// A block missing mimeType used to render "[Image: [undefined]]"
					// through the old `any`-typed path; label it generically instead.
					const mimeType = img.mimeType ?? "image";
					const dims = img.data ? (getImageDimensions(img.data, mimeType) ?? undefined) : undefined;
					return imageFallback(mimeType, dims);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	/**
	 * Format a generic tool execution (fallback for tools without custom renderers)
	 */
	#formatToolExecution(contentWidth: number): string {
		const lines: string[] = [];
		// Same rule as the renderer branches: a call that never reached the tool has no result here,
		// so it neither prints the model-facing placeholder as output nor wears the error glyph. The
		// notice under the block is what says it did not run.
		const result = isNeverRanResult(this.#result) ? undefined : this.#result;
		const icon = this.#isPartial
			? this.#spinnerFrame !== undefined
				? "running"
				: "pending"
			: result?.isError
				? "error"
				: "done";
		lines.push(renderStatusLine({ icon, spinnerFrame: this.#spinnerFrame, title: this.#toolLabel }, theme));

		const argsObject = this.#args && typeof this.#args === "object" ? (this.#args as Record<string, unknown>) : null;
		if (!this.#expanded && argsObject && Object.keys(argsObject).length > 0) {
			// Budget the inline preview against the render width, leaving room for
			// the ` └─ ` connector prefix instead of a fixed cap.
			const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(theme.tree.last) - 2);
			const preview = formatArgsInline(argsObject, inlineBudget);
			if (preview) {
				lines.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
			}
		}

		if (this.#expanded && this.#args !== undefined) {
			lines.push("");
			lines.push(theme.fg("dim", "Args"));
			const tree = renderJsonTreeLines(
				this.#args,
				theme,
				JSON_TREE_MAX_DEPTH_EXPANDED,
				JSON_TREE_MAX_LINES_EXPANDED,
				JSON_TREE_SCALAR_LEN_EXPANDED,
			);
			lines.push(...tree.lines);
			if (tree.truncated) {
				lines.push(theme.fg("dim", "…"));
			}
			lines.push("");
		}

		if (!result) {
			return lines.join("\n");
		}

		const textContent = this.#getTextOutput().trimEnd();
		if (!textContent) {
			lines.push(theme.fg("dim", "(no output)"));
			return lines.join("\n");
		}

		if (textContent.startsWith("{") || textContent.startsWith("[")) {
			try {
				const parsed = JSON.parse(textContent);
				const maxDepth = this.#expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
				const maxLines = this.#expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
				const maxScalarLen = this.#expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
				const tree = renderJsonTreeLines(parsed, theme, maxDepth, maxLines, maxScalarLen);

				if (tree.lines.length > 0) {
					lines.push(...tree.lines);
					if (!this.#expanded) {
						lines.push(formatExpandHint(theme, this.#expanded, true));
					} else if (tree.truncated) {
						lines.push(theme.fg("dim", "…"));
					}
					return lines.join("\n");
				}
			} catch {
				// Fall through to raw output
			}
		}

		const outputLines = textContent.split("\n");
		const maxOutputLines = this.#expanded ? 12 : 4;
		const displayLines = outputLines.slice(0, maxOutputLines);

		for (const line of displayLines) {
			lines.push(theme.fg("toolOutput", truncateToWidth(replaceTabs(line), contentWidth)));
		}

		if (outputLines.length > maxOutputLines) {
			const remaining = outputLines.length - maxOutputLines;
			lines.push(
				`${theme.fg("dim", `… ${formatMoreLines(remaining)}`)} ${formatExpandHint(theme, this.#expanded, true)}`,
			);
		} else if (!this.#expanded) {
			lines.push(formatExpandHint(theme, this.#expanded, true));
		}

		return lines.join("\n");
	}
}
