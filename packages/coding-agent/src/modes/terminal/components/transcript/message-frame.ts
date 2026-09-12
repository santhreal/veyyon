/**
 * Shared rendering for extension/hook custom message frames.
 *
 * Both `CustomMessageComponent` and `HookMessageComponent` wrap a
 * `Spacer(1) + Box` layout, try a user-supplied renderer first, and fall
 * back to a label + markdown body when the renderer returns nothing or
 * throws. The only meaningful difference is that hook messages collapse to
 * the first N lines when not expanded; extension messages render in full.
 */

import type { HostView } from "@veyyon/kernel/registry/host-view";
import { Box, type Component, Container, Markdown, Spacer, TERMINAL, Text } from "@veyyon/tui";
import type { CustomBlock, HookBlock } from "@veyyon/wire/presentation";
import { groundHairlineHex, groundTintFgAnsi } from "../../../../theme/ground-tints";
import { getMarkdownTheme } from "../../../../theme/markdown-theme";
import { type Theme, type ThemeColor, theme } from "../../../../theme/theme";
import { reportRendererFailure } from "./renderer-failure";

/**
 * Card-outline paint: the OSC 11-derived ground tint when the terminal
 * reported its background (a fixed contrast step above ANY ground), else the
 * static borderMuted token (calibrated for near-black terminals). One owner
 * for every outlined transcript card.
 */
export function cardOutlineColor(): (text: string) => string {
	const derived = groundTintFgAnsi(groundHairlineHex(), TERMINAL.trueColor);
	if (derived !== undefined) return text => `${derived}${text}\x1b[39m`;
	return text => theme.fg("borderMuted", text);
}

/** Message shape consumed by the shared frame. */
export type FramedMessage = CustomBlock | HookBlock;

/** Host-local closure provided by the producer/composition boundary. */
export type CustomRenderCapability = (options: { expanded: boolean }, theme: Theme) => HostView | undefined;

export interface RebuildFrameOptions<M extends FramedMessage = FramedMessage> {
	message: M;
	box: Box;
	expanded: boolean;
	/** Icon glyph shown before the customType in the default header (e.g. a hook/extension icon). */
	icon?: string;
	/** Collapse the markdown body to this many lines when `expanded` is false. Omit to never collapse. */
	collapseAfterLines?: number;
	customRenderer?: CustomRenderCapability;
}

const HOOK_COLLAPSED_LINES = 5;

/** Shared expansion, invalidation, and renderer replacement for custom and hook cards. */
export class FramedMessageComponent<M extends FramedMessage> extends Container {
	#box = new Box(1, 1);
	#customComponent?: Component;
	#expanded = false;

	constructor(
		private readonly message: M,
		private readonly customRenderer?: CustomRenderCapability,
	) {
		super();
		this.#box.setIgnoreTight(true);
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		if (this.#customComponent) {
			this.removeChild(this.#customComponent);
			this.#customComponent = undefined;
		}
		this.removeChild(this.#box);
		const custom = renderFramedMessage({
			message: this.message,
			box: this.#box,
			expanded: this.#expanded,
			customRenderer: this.customRenderer,
			collapseAfterLines: this.message.kind === "hook" ? HOOK_COLLAPSED_LINES : undefined,
		});
		this.#customComponent = custom;
		this.addChild(custom ?? this.#box);
	}
}

/** Reader-facing name for a framed message's renderer, used in a failure notice. */
export function framedRendererSubject(customType: string): string {
	return `custom message "${customType}"`;
}

/**
 * Attempt the custom renderer; on failure or undefined return, populate `box`
 * with the default outlined card — an `icon customType` header + markdown body —
 * and return undefined. When the custom renderer succeeds, return its Component
 * so the caller can mount it and skip the default box.
 *
 * A renderer that RETURNS undefined is declining to draw, which is a supported
 * choice and stays silent. A renderer that THROWS is broken, so the card the
 * operator gets instead carries a loud notice row (Law 10: no silent fallback).
 */
export function renderFramedMessage<M extends FramedMessage>(opts: RebuildFrameOptions<M>): Component | undefined {
	const customType = opts.message.kind === "hook" ? opts.message.hookName : opts.message.customKind;
	let failureRow: Text | undefined;
	if (opts.customRenderer) {
		try {
			const component = opts.customRenderer({ expanded: opts.expanded }, theme);
			if (component) return component as Component;
		} catch (err) {
			failureRow = reportRendererFailure(framedRendererSubject(customType), err, "showing the default card");
		}
	}

	opts.box.clear();
	// Match the skill card: a subtle rounded outline so injected messages read as cards.
	opts.box.setBorder({ chars: theme.boxSharp, color: cardOutlineColor() });
	// Cards hug their content instead of stretching the frame to the terminal
	// edge (defect: boxes always full width regardless of content).
	opts.box.setHugContent(true);

	const isHook = opts.message.kind === "hook" || opts.icon === theme.icon.extensionHook;
	let icon = opts.icon ?? (isHook ? theme.icon.extensionHook : theme.icon.package);
	let labelColor: ThemeColor = "customMessageLabel";
	if (opts.message.level === "error") {
		icon = theme.status.error;
		labelColor = "error";
	} else if (opts.message.level === "warning") {
		icon = theme.status.warning;
		labelColor = "warning";
	}
	const tag = icon ? `${icon} ${customType}` : customType;
	opts.box.addChild(new Text(theme.fg(labelColor, theme.bold(tag)), 0, 0));
	if (failureRow) opts.box.addChild(failureRow);
	opts.box.addChild(new Spacer(1));

	let text = opts.message.text;

	if (!opts.expanded && opts.collapseAfterLines !== undefined) {
		const lines = text.split("\n");
		if (lines.length > opts.collapseAfterLines) {
			text = `${lines.slice(0, opts.collapseAfterLines).join("\n")}\n…`;
		}
	}

	opts.box.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);

	return undefined;
}
