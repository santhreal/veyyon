import { type Component, getPaddingX, Text } from "@veyyon/tui";

/** Text whose content is (re)formatted against the actual render width. A plain `Text` receives an already-formatted string and only wraps it at */
export class WidthAwareText implements Component {
	#format: (contentWidth: number) => string;
	readonly #paddingX: number;
	#inner: Text;
	#cachedContentWidth = -1;
	#cachedText: string | undefined;
	#ignoreTight = false;

	constructor(format: (contentWidth: number) => string, paddingX = 1, paddingY = 1) {
		this.#format = format;
		this.#paddingX = paddingX;
		this.#inner = new Text("", paddingX, paddingY);
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.#inner.setCustomBgFn(customBgFn);
	}

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.#inner.setIgnoreTight(ignore);
		this.invalidate();
		return this;
	}

	invalidate(): void {
		this.#cachedContentWidth = -1;
		this.#cachedText = undefined;
		this.#inner.invalidate();
	}

	render(width: number): readonly string[] {
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		if (this.#cachedText === undefined || contentWidth !== this.#cachedContentWidth) {
			this.#cachedContentWidth = contentWidth;
			this.#cachedText = this.#format(contentWidth);
			this.#inner.setText(this.#cachedText);
		}
		return this.#inner.render(width);
	}
}
