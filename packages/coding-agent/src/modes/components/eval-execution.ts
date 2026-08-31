/**
 * Component for displaying user-initiated eval execution with streaming output.
 * Shares the same kernel session as the agent's eval tool.
 */

import { Container, type Loader, Text, type TUI } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import type { TruncationMeta } from "../../tools/output-meta";
import { highlightCode } from "../theme/highlight";
import { theme } from "../theme/theme-binding";
import {
	buildExecutionFrame,
	buildStatusFooter,
	capExecutionOutputLines,
	clampExecutionDisplayLine,
	createCollapsedPreview,
	EXECUTION_PREVIEW_LINES,
	type ExecutionColorKey,
	type ExecutionStatus,
	resolveExecutionStatus,
} from "./execution-shared";

export type EvalExecutionLanguage = "python" | "js";

export class EvalExecutionComponent extends Container {
	#outputLines: string[] = [];
	#droppedLineCount = 0;
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	#contentContainer: Container;

	#highlightLang(): "python" | "javascript" {
		return this.language === "js" ? "javascript" : "python";
	}

	#formatHeader(colorKey: ExecutionColorKey): Text {
		const prompt = theme.fg(colorKey, theme.bold(">>>"));
		const continuation = theme.fg(colorKey, "    ");
		const codeLines = highlightCode(this.code, this.#highlightLang());
		const headerLines = codeLines.map((line, index) =>
			index === 0 ? `${prompt} ${line}` : `${continuation}${line}`,
		);
		return new Text(headerLines.join("\n"), 2, 0);
	}

	constructor(
		private readonly code: string,
		ui: TUI,
		private readonly excludeFromContext = false,
		private readonly language: EvalExecutionLanguage = "python",
	) {
		super();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		this.#contentContainer.addChild(this.#formatHeader(colorKey));
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed
	 * streaming preview rewrites its tail window every chunk, so the block must
	 * stay out of native scrollback until the cell completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Chunk is pre-sanitized by OutputSink.push() — no need to sanitize again.
		const newLines = chunk.split("\n").map(line => clampExecutionDisplayLine(line));
		if (this.#outputLines.length > 0 && newLines.length > 0) {
			this.#outputLines[this.#outputLines.length - 1] = clampExecutionDisplayLine(
				`${this.#outputLines[this.#outputLines.length - 1]}${newLines[0]}`,
			);
			this.#outputLines.push(...newLines.slice(1));
		} else {
			this.#outputLines.push(...newLines);
		}

		// Same bound bash has always had. Without it a long-running cell grew its retained lines without limit,
		// which is the whole reason this now comes from one place.
		this.#droppedLineCount += capExecutionOutputLines(this.#outputLines);

		this.#updateDisplay();
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

		this.#loader.stop();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		const availableLines = this.#outputLines;
		const previewLogicalLines = availableLines.slice(-EXECUTION_PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		this.#contentContainer.clear();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		this.#contentContainer.addChild(this.#formatHeader(colorKey));

		if (availableLines.length > 0) {
			if (this.#expanded) {
				const displayText = availableLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 2, 0));
			} else {
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, EXECUTION_PREVIEW_LINES));
			}
		}

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				hiddenLineCount,
				droppedLineCount: this.#droppedLineCount,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		this.#outputLines = clean ? clean.split("\n").map(line => clampExecutionDisplayLine(line)) : [];
		// The authoritative output replaces whatever streaming kept, so nothing is missing any more.
		this.#droppedLineCount = 0;
	}

	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	getCode(): string {
		return this.code;
	}
}
