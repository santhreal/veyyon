import type { LoaderMessageColorFn } from "@veyyon/tui";
import { Loader, TERMINAL } from "@veyyon/tui";
import { adjustHsv, formatClock } from "@veyyon/utils";
import { isSettingsInitialized, settings } from "../../../config/settings";
import {
	lavaText,
	livingSpinnerColor,
	type ShimmerPalette,
	shimmerEnabled,
	shimmerSegments,
	shimmerText,
} from "../../../theme/shimmer";
import { getSymbolTheme, theme } from "../../../theme/theme";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { interruptHint } from "../shared";
import type { InteractiveModeContext } from "../types";

/**
 * The slice of the interactive context this controller uses: 3 members of the
 * 215 `InteractiveModeContext` declares. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces.
 */
export type WorkingLoaderContext = Pick<InteractiveModeContext, "sessionManager" | "statusContainer" | "ui">;

const HINT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "borderAccent",
};

interface WorkingMessageAccent {
	main: string;
	dim: string;
}

interface WorkingMessageAccentCacheKey {
	sessionName: string | undefined;
	accentSurfaceLuminance: number | undefined;
	sessionAccentEnabled: boolean;
}

/**
 * Intern the shimmer palettes for each `WorkingMessageAccent` so `compile()`
 * inside `shimmerSegments` sees a stable palette object between animation
 * ticks. Allocating fresh palette literals every frame guaranteed a cache miss
 * on the Symbol-keyed compiled-ANSI slot and forced `resolveTierAnsi` to walk
 * every tier open/close for the ~30fps loader redraw (issue #4377).
 */
const workingMessagePaletteCache = new WeakMap<WorkingMessageAccent, { main: ShimmerPalette; hint: ShimmerPalette }>();

function workingMessagePalettes(accent: WorkingMessageAccent): { main: ShimmerPalette; hint: ShimmerPalette } {
	let entry = workingMessagePaletteCache.get(accent);
	if (!entry) {
		entry = {
			main: { low: "dim", mid: { ansi: accent.main }, high: { ansi: accent.main }, bold: true },
			hint: { low: "dim", mid: { ansi: accent.dim }, high: { ansi: accent.dim } },
		};
		workingMessagePaletteCache.set(accent, entry);
	}
	return entry;
}

function renderWorkingMessage(message: string, accent?: WorkingMessageAccent, clockText?: string): string {
	const palettes = accent ? workingMessagePalettes(accent) : undefined;
	const palette = palettes?.main;
	const hintPalette = palettes?.hint ?? HINT_SHIMMER_PALETTE;
	const hint = interruptHint();
	let body = message;
	let hasHint = false;
	if (body.endsWith(hint)) {
		body = body.slice(0, -hint.length);
		hasHint = true;
	}
	// The per-task elapsed clock (` · 0:42`) sits between the label and the esc
	// hint. It is whisper chrome, not part of the task label, so it takes the
	// hint's dim palette instead of shimmering with the message body.
	let clock = "";
	if (clockText && body.endsWith(clockText)) {
		body = body.slice(0, -clockText.length);
		clock = clockText;
	}
	if (!hasHint && !clock) return shimmerText(message, theme, palette);
	const segments = [{ text: body, palette }];
	if (clock) segments.push({ text: clock, palette: hintPalette });
	if (hasHint) segments.push({ text: hint, palette: hintPalette });
	return shimmerSegments(segments, theme);
}

/**
 * The working line: the spinner in the status area, the task label it shows, the
 * per-task elapsed clock, and the session accent the label shimmers in.
 *
 * The loader instance is exposed because a caller mounts a transient loader of
 * its own (auto-compaction, retry) into the same container and reads this one to
 * tell whether the agent's working line is up. Every mutation of it goes through
 * this controller: a stopped loader left mounted keeps drawing its last frame
 * byte-identically, and an unchanging chrome row is indistinguishable from
 * settled transcript content to the code deciding what may enter scrollback.
 */
export class WorkingLoaderController {
	#context: WorkingLoaderContext;
	#loader: Loader | undefined;
	#pendingMessage: string | undefined;
	// Per-task elapsed clock on the working line: the label is the task, the
	// clock is how long that exact label has been showing. Reset whenever the
	// label changes (each tool call / working phase sets a new one).
	#taskLabel: string | undefined;
	#taskHasHint = false;
	#taskStartedAt = 0;
	#clockText: string | undefined;
	#accentCacheKey?: WorkingMessageAccentCacheKey;
	#accentCacheValue?: WorkingMessageAccent;
	#accentCacheHasValue = false;

	constructor(context: WorkingLoaderContext) {
		this.#context = context;
	}

	/** The mounted working loader, or `undefined` while the agent rests. */
	get loader(): Loader | undefined {
		return this.#loader;
	}

	get #defaultMessage(): string {
		return `Working…${interruptHint()}`;
	}

	/**
	 * Mount the working loader, or remount it when something else cleared the
	 * status container out from under it. The caller repaints the todo board:
	 * this edge is where the agent starts moving, and the board's motion is owed
	 * by that.
	 */
	ensure(): void {
		if (!this.#loader) {
			this.clearAccentCache();
			this.#context.statusContainer.disposeChildren();
			const messageColorFn = ((message: string) =>
				renderWorkingMessage(message, this.#accent(), this.#clockText)) as LoaderMessageColorFn & {
				animated?: true;
			};
			// Shimmer drives the 30fps redraw; when it is disabled the working
			// message is static, so leave `animated` unset and let the loader use
			// the spinner-only ~12.5fps cadence instead of repainting a frozen line.
			if (shimmerEnabled()) messageColorFn.animated = true;
			this.#loader = new Loader(
				this.#context.ui,
				spinner => {
					// The breathing-pixel spinner keeps its frames and runs MOLTEN —
					// the warm arc's lava heat cycle — while the agent works (the one
					// live thing). Semantic activity states still win: in living mode
					// ask/error recolor the whole line green/red via the living hue.
					const living = livingSpinnerColor(theme);
					if (living) return `${living}${spinner}\x1b[39m`;
					const accent = this.#accent();
					if (accent) return `${accent.main}${spinner}\x1b[39m`;
					return lavaText(spinner, theme, TERMINAL.trueColor);
				},
				messageColorFn,
				this.#defaultMessage,
				getSymbolTheme().spinnerFrames,
			);
			this.#context.statusContainer.addChild(this.#loader);
			// Seed the per-task clock for the default "Working…" phase so the
			// elapsed readout is present from the first painted frame.
			this.resetTaskClock();
			this.#setTaskMessage(this.#defaultMessage);
		} else if (!this.#context.statusContainer.children.includes(this.#loader)) {
			this.#context.statusContainer.disposeChildren();
			this.#context.statusContainer.addChild(this.#loader);
			this.#context.ui.requestRender();
		}
		this.applyPendingMessage();
	}

	/**
	 * Stop the loader, unmount it and drop the reference. Returns whether there
	 * was one to clear, so the caller can skip the work that follows.
	 *
	 * It removes only its OWN child, never the container's other children: a
	 * transient overlay (auto-compaction, retry) mounts its own loader here and
	 * owns its own teardown.
	 */
	clear(): boolean {
		if (!this.#loader) return false;
		this.#loader.stop();
		this.#context.statusContainer.removeChild(this.#loader);
		this.#loader = undefined;
		this.resetTaskClock();
		return true;
	}

	/**
	 * Clear the loader and, when asked, everything else in the status container.
	 * Used by the paths that abort a turn outside the normal agent_end route.
	 */
	stop(clearStatusContainer: boolean): void {
		if (!this.clear()) return;
		this.clearAccentCache();
		if (clearStatusContainer) {
			this.#context.statusContainer.disposeChildren();
		}
	}

	/**
	 * Stop the loader and forget it without touching the container, for a caller
	 * that disposes every child itself immediately afterwards.
	 */
	abandon(): void {
		if (!this.#loader) return;
		this.#loader.stop();
		this.#loader = undefined;
		this.resetTaskClock();
	}

	/**
	 * Set the task the working line reports. `undefined` restores the default
	 * "Working…" phase. Arrives before the loader exists on the fast paths, so it
	 * is held and applied by `ensure()`.
	 */
	setMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingMessage = undefined;
			if (this.#loader) {
				this.#setTaskMessage(this.#defaultMessage);
			}
			return;
		}
		if (this.#loader) {
			this.#setTaskMessage(message);
			return;
		}
		this.#pendingMessage = message;
	}

	/** Apply a message that arrived before the loader was mounted. */
	applyPendingMessage(): void {
		if (this.#pendingMessage === undefined) return;
		const message = this.#pendingMessage;
		this.#pendingMessage = undefined;
		this.setMessage(message);
	}

	/** Drop a queued message a cancelled or failed submission will never show. */
	clearPendingMessage(): void {
		this.#pendingMessage = undefined;
	}

	/** Repaint the elapsed clock. The one-second heartbeat rides this. */
	refreshTaskClock(): void {
		if (!this.#loader || this.#taskLabel === undefined) return;
		this.#clockText = ` · ${formatClock(Date.now() - this.#taskStartedAt)}`;
		this.#loader.setMessage(`${this.#taskLabel}${this.#clockText}${this.#taskHasHint ? interruptHint() : ""}`);
	}

	/** Forget the task clock when the working loader goes away, so the next
	 * run's first task starts its clock at 0:00 instead of inheriting one. */
	resetTaskClock(): void {
		this.#taskLabel = undefined;
		this.#taskHasHint = false;
		this.#taskStartedAt = 0;
		this.#clockText = undefined;
	}

	/** Drop the memoized session accent after a theme or session-name change. */
	clearAccentCache(): void {
		this.#accentCacheKey = undefined;
		this.#accentCacheValue = undefined;
		this.#accentCacheHasValue = false;
	}

	/**
	 * ONE composer for the working line: splits the caller's message into task
	 * label + esc hint, restarts the per-task clock when the label changes, and
	 * hands the loader `label · 0:42 ⟦esc⟧`. Re-invoking with the same label
	 * refreshes only the clock (the 1s heartbeat rides this).
	 */
	#setTaskMessage(message: string): void {
		const hint = interruptHint();
		const hasHint = message.endsWith(hint);
		const label = hasHint ? message.slice(0, -hint.length) : message;
		if (label !== this.#taskLabel) {
			this.#taskLabel = label;
			this.#taskStartedAt = Date.now();
		}
		this.#taskHasHint = hasHint;
		this.refreshTaskClock();
	}

	#accentCacheKeyEquals(a: WorkingMessageAccentCacheKey, b: WorkingMessageAccentCacheKey): boolean {
		return (
			a.sessionName === b.sessionName &&
			a.accentSurfaceLuminance === b.accentSurfaceLuminance &&
			a.sessionAccentEnabled === b.sessionAccentEnabled
		);
	}

	#buildAccentCacheKey(): WorkingMessageAccentCacheKey {
		const sessionAccentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
		return {
			sessionAccentEnabled,
			sessionName: sessionAccentEnabled ? this.#context.sessionManager.getSessionName() : undefined,
			accentSurfaceLuminance: theme.accentSurfaceLuminance,
		};
	}

	#cacheAccent(
		key: WorkingMessageAccentCacheKey,
		value: WorkingMessageAccent | undefined,
	): WorkingMessageAccent | undefined {
		this.#accentCacheKey = key;
		this.#accentCacheValue = value;
		this.#accentCacheHasValue = true;
		return value;
	}

	#accent(): WorkingMessageAccent | undefined {
		const key = this.#buildAccentCacheKey();
		if (this.#accentCacheHasValue && this.#accentCacheKey && this.#accentCacheKeyEquals(key, this.#accentCacheKey)) {
			return this.#accentCacheValue;
		}
		if (!key.sessionAccentEnabled || !key.sessionName) {
			return this.#cacheAccent(key, undefined);
		}
		const hex = getSessionAccentHex(key.sessionName, theme.getMajorThemeColorHexes(), key.accentSurfaceLuminance);
		const main = getSessionAccentAnsi(hex);
		const dim = getSessionAccentAnsi(adjustHsv(hex, { s: 0.55, v: 0.65 }));
		return this.#cacheAccent(key, main && dim ? { main, dim } : undefined);
	}
}
