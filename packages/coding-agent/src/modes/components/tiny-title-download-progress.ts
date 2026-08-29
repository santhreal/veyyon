import { type Component, SettleValue } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils";
import { getTinyTitleModelSpec, type TinyTitleLocalModelKey } from "../../tiny/models";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { theme } from "../theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import type { TinyTitleDownloadProgressOptions } from "./tiny-title-download-progress-helpers";
import { byteLabel, currentFile, progressBar, statusLabel } from "./tiny-title-download-progress-helpers";

export class TinyTitleDownloadProgressComponent implements Component {
	#modelKey: TinyTitleLocalModelKey;
	#event: TinyTitleProgressEvent | undefined;
	readonly #ratio: SettleValue | undefined;

	constructor(modelKey: TinyTitleLocalModelKey, options: TinyTitleDownloadProgressOptions = {}) {
		this.#modelKey = modelKey;
		const requestRender = options.requestRender;
		if (requestRender) {
			this.#ratio = new SettleValue({ requestRender, enabled: options.enabled, clock: options.clock });
		}
	}

	update(event: TinyTitleProgressEvent): void {
		this.#event = event;
		if (event.progress !== undefined) this.#ratio?.set(clamp01(event.progress / 100));
	}

	isComplete(): boolean {
		return this.#event?.status === "ready" || this.#event?.status === "error";
	}

	invalidate(): void {}

	dispose(): void {
		this.#ratio?.dispose();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const inset = " ".repeat(COMPOSER_INSET_COLS);
		const spec = getTinyTitleModelSpec(this.#modelKey);
		const dot = theme.sep.dot.trim();
		const status = statusLabel(this.#event);
		const file = currentFile(this.#event);
		const pct =
			this.#event?.progress === undefined ? "" : `${Math.floor(this.#event.progress).toString().padStart(3, " ")}%`;
		const bytes = byteLabel(this.#event);
		const title = [theme.fg("accent", "Tiny model"), theme.fg("muted", status), theme.fg("dim", spec.label)].join(
			theme.fg("dim", ` ${dot} `),
		);
		const reported = this.#event?.progress === undefined ? undefined : clamp01(this.#event.progress / 100);
		const parts = [progressBar(this.#ratio?.value ?? reported, Math.max(8, width - COMPOSER_INSET_COLS - 36))];
		for (let pi = 0; pi < 3; pi++) {
			const part = [pct, bytes, file][pi];
			if (part) parts.push(theme.fg("dim", part));
		}
		const details = parts.join(" ");

		return [`${inset}${title}`, `${inset}${details}`];
	}
}
