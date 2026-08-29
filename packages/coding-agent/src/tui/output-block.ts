import type { Component } from "@veyyon/tui";
import type { Theme } from "../modes/theme/theme";
import type { OutputBlockOptions } from "./output-block-helpers";
import { markFramedBlockComponent, normalizeContentPaddingLeft, renderOutputBlock } from "./output-block-helpers";
import type { RenderCache } from "./utils";
import { Hasher } from "./utils";

export { isFramedBlockComponent, outputBlockContentWidth } from "./output-block-helpers";
export type { OutputBlockOptions };
export { markFramedBlockComponent, renderOutputBlock };

export class CachedOutputBlock {
	#cache?: RenderCache;

	render(options: OutputBlockOptions, theme: Theme): readonly string[] {
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) return this.#cache.lines;
		const lines = renderOutputBlock(options, theme);
		this.#cache = { key, lines };
		return lines;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.u32(normalizeContentPaddingLeft(options.contentPaddingLeft));
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.optional(options.borderColor);
		h.bool(options.applyBg ?? true);
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				h.bool(s.separator ?? false);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}

export function framedBlock(theme: Theme, build: (width: number) => OutputBlockOptions): Component {
	const block = new CachedOutputBlock();
	return markFramedBlockComponent({
		render: (width: number): readonly string[] => block.render(build(width), theme),
		invalidate: () => block.invalidate(),
	});
}
