/**
 * Production TranscriptBlock component.
 *
 * Renders any `TranscriptBlock` union member by hosting its dedicated production
 * transcript component, maintaining expansion state across updates, and delegating
 * streaming, scrollback finalization, versioning, and invalidation hooks.
 */

import { type Component, Container, Text, type TUI } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import type { CustomBlock, ErrorBlock, HookBlock, TranscriptBlock, UserMessageBlock } from "@veyyon/wire/presentation";
import type { AssistantThinkingRenderer } from "../../../../extensibility/extensions/types";
import { theme } from "../../../../theme/theme";
import { shortenEmbeddedPaths } from "../../../../tools/core/render-utils";
import { buildFileMentionBlock, renderAttachmentRow } from "../../utils/transcript-render-helpers";
import { COMPOSER_INSET_COLS } from "../composer/composer-chrome";
import { AssistantMessageComponent } from "./assistant-message";
import { BashExecutionComponent } from "./bash-execution";
import { BranchSummaryMessageComponent, CompactionSummaryMessageComponent } from "./compaction-summary-message";
import { CustomMessageComponent, createSpecializedCustomComponent } from "./custom-message";
import { EvalExecutionComponent } from "./eval-execution";
import { HookMessageComponent } from "./hook-message";
import type { CustomRenderCapability } from "./message-frame";
import { ToolExecutionComponent } from "./tool-execution";
import { UserMessageComponent } from "./user-message";
export interface TranscriptBlockComponentOptions {
	tui: TUI;
	onRequestRender: () => void;
	expanded?: boolean;
	cwd?: string;
	getCustomRenderer?: (block: CustomBlock | HookBlock) => CustomRenderCapability | undefined;
	getThinkingRenderers?: () => AssistantThinkingRenderer[] | undefined;
	hideThinkingBlock?: boolean | (() => boolean);
	proseOnlyThinking?: boolean | (() => boolean);
}

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(component: Component | undefined): component is Component & Expandable {
	return (
		typeof component === "object" &&
		component !== null &&
		"setExpanded" in component &&
		typeof component.setExpanded === "function"
	);
}

interface Finalizable {
	isTranscriptBlockFinalized?(): boolean;
	getTranscriptBlockVersion?(): number;
	getTranscriptBlockSettledRows?(): number;
	isDisplaceableBlock?(): boolean;
	seal?(): void;
}

function createUserBlock(block: UserMessageBlock): Component {
	const userComp = new UserMessageComponent(block);
	if (!block.attachments || block.attachments.length === 0) {
		return userComp;
	}
	const container = new Container();
	container.addChild(userComp);
	for (const attachment of block.attachments) {
		container.addChild(renderAttachmentRow(attachment, 4));
	}
	return container;
}

function createErrorBlock(error: ErrorBlock): Container {
	const container = new Container();
	const clean = sanitizeText(shortenEmbeddedPaths(error.message)).trim();
	const lines = clean.length === 0 ? ["Unknown error"] : clean.split("\n");
	const statusText = error.recoverable
		? `${theme.status.error} ${lines[0]}`
		: `${theme.status.error} Fatal Error: ${lines[0]}`;

	container.addChild(new Text(theme.bold(theme.fg("error", statusText)), COMPOSER_INSET_COLS, 0));
	for (const line of lines.slice(1)) {
		container.addChild(new Text(theme.fg("error", `  ${line}`), COMPOSER_INSET_COLS, 0));
	}
	if (!error.recoverable) {
		container.addChild(new Text(theme.fg("dim", "  (turn aborted — unrecoverable)"), COMPOSER_INSET_COLS, 0));
	}
	return container;
}

export class TranscriptBlockComponent extends Container implements Component {
	#block: TranscriptBlock;
	#options: TranscriptBlockComponentOptions;
	#innerComponent: Component | undefined;
	#expanded: boolean;
	#baseVersion = 0;

	constructor(block: TranscriptBlock, options: TranscriptBlockComponentOptions) {
		super();
		this.#block = block;
		this.#options = options;
		this.#expanded = options.expanded ?? false;
		this.#mount(block);
	}

	get block(): TranscriptBlock {
		return this.#block;
	}

	get value(): TranscriptBlock {
		return this.#block;
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#baseVersion++;
		if (isExpandable(this.#innerComponent)) {
			this.#innerComponent.setExpanded(expanded);
		}
		this.invalidate();
	}

	set(block: TranscriptBlock): void {
		const previousKind = this.#block.kind;
		this.#block = block;
		this.#baseVersion++;

		if (block.kind === previousKind && this.#innerComponent !== undefined) {
			if (this.#updateExisting(block)) {
				this.invalidate();
				return;
			}
		}

		this.#mount(block);
		this.invalidate();
	}
	remount(): void {
		this.#baseVersion++;
		this.#mount(this.#block);
		this.invalidate();
	}

	stopAnimation(): void {
		const animatable = this.#innerComponent as { stopAnimation?: () => void } | undefined;
		if (animatable && typeof animatable.stopAnimation === "function") {
			animatable.stopAnimation();
		}
	}

	override dispose(): void {
		if (this.#innerComponent !== undefined) {
			this.removeChild(this.#innerComponent);
			this.#innerComponent.dispose?.();
			this.#innerComponent = undefined;
		}
		super.dispose();
	}

	#mount(block: TranscriptBlock): void {
		if (this.#innerComponent !== undefined) {
			const previousInnerVersion =
				(this.#innerComponent as Finalizable | undefined)?.getTranscriptBlockVersion?.() ?? 0;
			this.#baseVersion += previousInnerVersion;
			this.removeChild(this.#innerComponent);
			this.#innerComponent.dispose?.();
			this.#innerComponent = undefined;
		}

		const component = this.#createComponent(block);
		this.#innerComponent = component;
		if (isExpandable(component)) {
			component.setExpanded(this.#expanded);
		}
		this.addChild(component);
	}

	#createComponent(block: TranscriptBlock): Component {
		switch (block.kind) {
			case "user-message":
				return createUserBlock(block);
			case "developer-message":
				return new UserMessageComponent({ text: block.text, synthetic: true, imageLinks: block.imageLinks });
			case "assistant-message": {
				const hideThinking =
					typeof this.#options.hideThinkingBlock === "function"
						? this.#options.hideThinkingBlock()
						: (this.#options.hideThinkingBlock ?? false);
				const proseOnly =
					typeof this.#options.proseOnlyThinking === "function"
						? this.#options.proseOnlyThinking()
						: (this.#options.proseOnlyThinking ?? true);
				const thinkingRenderers = this.#options.getThinkingRenderers?.();
				const assistantComp = new AssistantMessageComponent(
					block.streaming ? undefined : block,
					hideThinking,
					this.#options.onRequestRender,
					thinkingRenderers,
					this.#options.tui.imageBudget,
					proseOnly,
					() => this.#options.tui.requestComponentRender(assistantComp),
				);
				if (block.streaming) {
					assistantComp.updateContent(block, { transient: true });
				}
				return assistantComp;
			}
			case "tool-execution":
				return new ToolExecutionComponent(block, {
					ui: this.#options.tui,
					expanded: this.#expanded,
					cwd: this.#options.cwd,
				});
			case "bash-execution": {
				const bashComp = new BashExecutionComponent(block.command, this.#options.tui, false);
				if (block.output) {
					bashComp.setOutput(block.output);
				}
				if (block.exitCode !== null || block.cancelled || block.signal !== undefined) {
					bashComp.setComplete(block.exitCode ?? undefined, block.cancelled, {
						output: block.output,
						signal: block.signal,
					});
				}
				return bashComp;
			}
			case "python-execution": {
				const evalComp = new EvalExecutionComponent(block.code, this.#options.tui, false, "python");
				if (block.output) {
					evalComp.setOutput(block.output);
				}
				if (block.exitCode !== null || block.cancelled) {
					evalComp.setComplete(block.exitCode ?? undefined, block.cancelled, { output: block.output });
				}
				return evalComp;
			}
			case "custom": {
				if (block.display !== undefined) {
					return createSpecializedCustomComponent(block.display, () => this.#expanded);
				}
				const renderCustom = this.#options.getCustomRenderer?.(block);
				return new CustomMessageComponent(block, renderCustom);
			}
			case "hook": {
				if (block.display !== undefined) {
					return createSpecializedCustomComponent(block.display, () => this.#expanded);
				}
				const renderCustom = this.#options.getCustomRenderer?.(block);
				return new HookMessageComponent(block, renderCustom);
			}
			case "branch-summary":
				return new BranchSummaryMessageComponent(block);
			case "compaction-summary":
				return new CompactionSummaryMessageComponent(block);
			case "file-mention":
				return buildFileMentionBlock(block.files, 1);
			case "error":
				return createErrorBlock(block);
			default: {
				const exhaustive: never = block;
				throw new Error(`Unhandled transcript block kind: ${(exhaustive as { kind: string }).kind}`);
			}
		}
	}

	#updateExisting(block: TranscriptBlock): boolean {
		const comp = this.#innerComponent;
		if (comp === undefined) return false;

		switch (block.kind) {
			case "assistant-message": {
				if (comp instanceof AssistantMessageComponent) {
					comp.updateContent(block, { transient: block.streaming });
					if (!block.streaming) {
						comp.markTranscriptBlockFinalized();
					}
					return true;
				}
				return false;
			}
			case "tool-execution": {
				if (comp instanceof ToolExecutionComponent) {
					comp.set(block);
					return true;
				}
				return false;
			}
			case "bash-execution": {
				if (comp instanceof BashExecutionComponent) {
					if (comp.getCommand() === block.command) {
						if (block.exitCode !== null || block.cancelled || block.signal !== undefined) {
							comp.setComplete(block.exitCode ?? undefined, block.cancelled, {
								output: block.output,
								signal: block.signal,
							});
						} else {
							comp.setOutput(block.output);
						}
						return true;
					}
					return false;
				}
				return false;
			}
			case "python-execution": {
				if (comp instanceof EvalExecutionComponent) {
					if (comp.getCode() === block.code) {
						if (block.exitCode !== null || block.cancelled) {
							comp.setComplete(block.exitCode ?? undefined, block.cancelled, { output: block.output });
						} else {
							comp.setOutput(block.output);
						}
						return true;
					}
					return false;
				}
				return false;
			}
			default:
				// For user/developer/summary/custom/hook/file/error, rebuild when updated
				return false;
		}
	}

	isTranscriptBlockFinalized(): boolean {
		const finalizable = this.#innerComponent as Finalizable | undefined;
		if (finalizable && typeof finalizable.isTranscriptBlockFinalized === "function") {
			return finalizable.isTranscriptBlockFinalized();
		}
		return true;
	}

	getTranscriptBlockVersion(): number {
		const finalizable = this.#innerComponent as Finalizable | undefined;
		const innerVersion =
			finalizable && typeof finalizable.getTranscriptBlockVersion === "function"
				? finalizable.getTranscriptBlockVersion()
				: 0;
		return this.#baseVersion + innerVersion;
	}

	getTranscriptBlockSettledRows(): number {
		const finalizable = this.#innerComponent as Finalizable | undefined;
		if (finalizable && typeof finalizable.getTranscriptBlockSettledRows === "function") {
			return finalizable.getTranscriptBlockSettledRows();
		}
		return 0;
	}

	isDisplaceableBlock(): boolean {
		const finalizable = this.#innerComponent as Finalizable | undefined;
		if (finalizable && typeof finalizable.isDisplaceableBlock === "function") {
			return finalizable.isDisplaceableBlock();
		}
		return false;
	}

	seal(): void {
		const finalizable = this.#innerComponent as Finalizable | undefined;
		if (finalizable && typeof finalizable.seal === "function") {
			finalizable.seal();
		}
	}
}
