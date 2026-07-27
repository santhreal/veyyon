/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, ImageProtocol, type Loader, TERMINAL, Text, type TUI } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import type { TruncationMeta } from "../../tools/output-meta";
import { getSixelLineMask, isSixelPassthroughEnabled, sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import {
	buildExecutionFrame,
	buildStatusFooter,
	capExecutionOutputLines,
	clampExecutionDisplayLine,
	createCollapsedPreview,
	EXECUTION_PREVIEW_LINES,
	type ExecutionStatus,
	resolveExecutionStatus,
} from "./execution-shared";

// Minimum interval between processing incoming chunks for display (ms).
// Chunks arriving faster than this are accumulated and processed in one batch.
const CHUNK_THROTTLE_MS = 50;

export class BashExecutionComponent extends Container {
	#outputLines: string[] = [];
	#droppedLineCount = 0;
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	#displayDirty = false;
	#chunkGate = false;
	#contentContainer: Container;
	#headerText: Text;

	constructor(
		private readonly command: string,
		ui: TUI,
		excludeFromContext = false,
	) {
		super();

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		// Command header
		this.#headerText = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 2, 0);
		this.#contentContainer.addChild(this.#headerText);
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed
	 * streaming preview rewrites its tail window every chunk, so the block must
	 * stay out of native scrollback until the command completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#displayDirty = false;
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		// During high-throughput output (e.g. seq 1 500M), processing every
		// chunk would saturate the event loop. Instead, accept one chunk per
		// throttle window and drop the rest — the OutputSink captures everything
		// for the artifact, and setComplete() replaces with the final output.
		if (this.#chunkGate) return;
		this.#chunkGate = true;
		setTimeout(() => {
			this.#chunkGate = false;
		}, CHUNK_THROTTLE_MS);

		const incomingLines = chunk.split("\n");
		if (this.#outputLines.length > 0 && incomingLines.length > 0) {
			const lastIndex = this.#outputLines.length - 1;
			const mergedLines = [`${this.#outputLines[lastIndex]}${incomingLines[0]}`, ...incomingLines.slice(1)];
			const clampedMergedLines = this.#clampLinesPreservingSixel(mergedLines);
			this.#outputLines[lastIndex] = clampedMergedLines[0] ?? "";
			this.#outputLines.push(...clampedMergedLines.slice(1));
		} else {
			this.#outputLines.push(...this.#clampLinesPreservingSixel(incomingLines));
		}

		// Cap stored lines during streaming to avoid unbounded memory growth, and remember how many went, so the
		// footer can say so instead of folding them into a hidden-line count that promises to reveal them.
		this.#droppedLineCount += capExecutionOutputLines(this.#outputLines);

		this.#displayDirty = true;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta },
	): void {
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#truncation = options?.truncation;
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}

		// Stop loader
		this.#loader.stop();

		this.#updateDisplay();
	}

	override render(width: number): readonly string[] {
		if (this.#displayDirty) {
			this.#displayDirty = false;
			this.#updateDisplay();
		}
		return super.render(width);
	}

	#updateDisplay(): void {
		const availableLines = this.#outputLines;

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-EXECUTION_PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;
		const sixelLineMask =
			TERMINAL.imageProtocol === ImageProtocol.Sixel && isSixelPassthroughEnabled()
				? getSixelLineMask(availableLines)
				: undefined;
		const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;

		// Rebuild content container
		this.#contentContainer.clear();

		// Command header
		this.#contentContainer.addChild(this.#headerText);

		// Output
		if (availableLines.length > 0) {
			if (this.#expanded || hasSixelOutput) {
				const displayText = availableLines
					.map((line, index) => (sixelLineMask?.[index] ? line : theme.fg("muted", line)))
					.join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 2, 0));
			} else {
				// Use shared visual truncation utility, recomputed per render width
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, EXECUTION_PREVIEW_LINES));
			}
		}

		// Loader or status
		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				hiddenLineCount,
				droppedLineCount: this.#droppedLineCount,
				suppressHiddenCount: hasSixelOutput,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#clampLinesPreservingSixel(lines: string[]): string[] {
		if (lines.length === 0) return [];
		const sixelLineMask = getSixelLineMask(lines);
		if (!sixelLineMask.some(Boolean)) {
			return lines.map(line => clampExecutionDisplayLine(line));
		}
		return lines.map((line, index) => (sixelLineMask[index] ? line : clampExecutionDisplayLine(line)));
	}

	#setOutput(output: string): void {
		const clean = sanitizeWithOptionalSixelPassthrough(output, sanitizeText);
		this.#outputLines = clean ? this.#clampLinesPreservingSixel(clean.split("\n")) : [];
		// The authoritative output replaces whatever streaming kept, so nothing is missing any more.
		this.#droppedLineCount = 0;
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
