import type { Container, TUI } from "@veyyon/tui";
import { isTinyTitleLocalModelKey, type TinyTitleLocalModelKey } from "../../../tiny/models";
import { tinyTitleClient } from "../../../tiny/title-client";
import type { TinyTitleProgressEvent } from "../../../tiny/title-protocol";
import { pointerMotionEnabled } from "../components/chrome/modal-shell";
import { TinyTitleDownloadProgressComponent } from "../components/chrome/tiny-title-download-progress";

/** How long the row of a finished download stays in the transcript before it leaves. */
export const TINY_TITLE_PROGRESS_DONE_TTL_MS = 3_000;
// A cached model fires its file-load events in a short burst and then goes silent
// while onnxruntime builds the session; a genuine download keeps streaming progress
// events for seconds. Only reveal the bar once a still-incomplete event arrives after
// this grace window, so an already-downloaded model never flashes the bar.
export const TINY_TITLE_PROGRESS_REVEAL_DELAY_MS = 1_000;

/** The transcript and repaint hook the row reads at the moment it adds, repaints or removes itself. */
export interface TinyTitleDownloadRowHost {
	readonly chatContainer: Pick<Container, "addChild" | "removeChild">;
	readonly ui: Pick<TUI, "requestRender">;
}

/**
 * The transcript row of one tiny-title model download. It appears for a download still in flight past the reveal
 * grace window and leaves when the download ends: at once when it never appeared, after the done TTL otherwise.
 */
class TinyTitleDownloadRow {
	readonly #host: TinyTitleDownloadRowHost;
	readonly #modelKey: TinyTitleLocalModelKey;
	readonly #component: TinyTitleDownloadProgressComponent;
	readonly #unsubscribe: () => void;
	#shown = false;
	#disposed = false;
	#removeTimer: NodeJS.Timeout | undefined;
	#revealAt = 0;

	constructor(host: TinyTitleDownloadRowHost, modelKey: TinyTitleLocalModelKey) {
		this.#host = host;
		this.#modelKey = modelKey;
		// The show site owns the ambient motion gate, as every other animated
		// surface here does: `display.transitions: off` and non-truecolor
		// terminals get the jump they had, everything else gets the travel.
		this.#component = new TinyTitleDownloadProgressComponent(modelKey, {
			requestRender: () => host.ui.requestRender(),
			enabled: pointerMotionEnabled(),
		});
		this.#unsubscribe = tinyTitleClient.onProgress(event => this.#update(event));
	}

	#update(event: TinyTitleProgressEvent): void {
		if (this.#disposed || event.modelKey !== this.#modelKey) return;
		this.#component.update(event);
		const complete = this.#component.isComplete();
		this.#reveal(complete);
		if (this.#shown) this.#host.ui.requestRender();
		if (!complete) return;
		if (this.#shown) this.#scheduleRemove();
		else this.#remove();
	}

	/**
	 * Adds the row for a download still in flight past the grace window. Cache hits either complete or fall silent
	 * (onnx init emits no events) before the window closes.
	 */
	#reveal(complete: boolean): void {
		if (this.#revealAt === 0) this.#revealAt = performance.now() + TINY_TITLE_PROGRESS_REVEAL_DELAY_MS;
		if (this.#shown || complete || performance.now() < this.#revealAt) return;
		this.#host.chatContainer.addChild(this.#component);
		this.#shown = true;
	}

	#scheduleRemove(): void {
		clearTimeout(this.#removeTimer);
		this.#removeTimer = setTimeout(() => this.#remove(), TINY_TITLE_PROGRESS_DONE_TTL_MS);
		this.#removeTimer.unref?.();
	}

	/** Runs once: on a hidden row's terminal event, or when a shown row's done-TTL fires. */
	#remove(): void {
		this.#disposed = true;
		this.#unsubscribe();
		// `removeChild` does not tear a child down, so the settle has to be
		// stopped here or it keeps asking for frames for a row that is gone.
		this.#component.dispose();
		if (!this.#shown) return;
		this.#host.chatContainer.removeChild(this.#component);
		this.#host.ui.requestRender();
	}
}

/** Tracks the download of `modelKey` in the transcript; a model that is not local downloads nothing and shows no row. */
export function showTinyTitleDownloadRow(host: TinyTitleDownloadRowHost, modelKey: string): void {
	if (isTinyTitleLocalModelKey(modelKey)) new TinyTitleDownloadRow(host, modelKey);
}
