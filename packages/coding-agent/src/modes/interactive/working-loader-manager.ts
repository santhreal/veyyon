import { Loader, type LoaderMessageColorFn, TERMINAL } from "@veyyon/tui";
import { adjustHsv, formatClock } from "@veyyon/utils";
import { isSettingsInitialized, settings } from "../../config/settings";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../utils/session-color";
import type { InteractiveMode } from "../interactive-mode";
import { interruptHint } from "../shared";
import { lavaText, livingSpinnerColor, shimmerEnabled } from "../theme/shimmer";
import { getSymbolTheme, theme } from "../theme/theme";
import type { WorkingMessageAccent, WorkingMessageAccentCacheKey } from "./working-loader-manager-helpers";
import { renderWorkingMessage } from "./working-loader-manager-helpers";

export class WorkingLoaderManager {
	#host: InteractiveMode;
	#taskLabel: string | undefined;
	#taskHasHint = false;
	#taskStartedAt = 0;
	#workingClockText: string | undefined;
	#clockTimer: NodeJS.Timeout | undefined;
	#workingMessageAccentCacheKey?: WorkingMessageAccentCacheKey;
	#workingMessageAccentCacheValue?: WorkingMessageAccent;
	#workingMessageAccentCacheHasValue = false;

	constructor(host: InteractiveMode) {
		this.#host = host;
	}

	get defaultWorkingMessage(): string {
		return `Working…${interruptHint()}`;
	}

	clearWorkingMessageAccentCache(): void {
		this.#workingMessageAccentCacheKey = undefined;
		this.#workingMessageAccentCacheValue = undefined;
		this.#workingMessageAccentCacheHasValue = false;
	}

	#buildWorkingMessageAccentCacheKey(): WorkingMessageAccentCacheKey {
		const sessionAccentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
		return {
			sessionAccentEnabled,
			sessionName: sessionAccentEnabled ? this.#host.sessionManager.getSessionName() : undefined,
			accentSurfaceLuminance: theme.accentSurfaceLuminance,
		};
	}

	#getWorkingMessageAccent(): WorkingMessageAccent | undefined {
		const key = this.#buildWorkingMessageAccentCacheKey();
		if (
			this.#workingMessageAccentCacheHasValue &&
			this.#workingMessageAccentCacheKey &&
			this.#workingMessageAccentCacheKey.sessionAccentEnabled === key.sessionAccentEnabled &&
			this.#workingMessageAccentCacheKey.sessionName === key.sessionName &&
			this.#workingMessageAccentCacheKey.accentSurfaceLuminance === key.accentSurfaceLuminance
		) {
			return this.#workingMessageAccentCacheValue;
		}

		this.#workingMessageAccentCacheKey = key;
		this.#workingMessageAccentCacheHasValue = true;

		if (!key.sessionAccentEnabled || !key.sessionName) {
			this.#workingMessageAccentCacheValue = undefined;
			return undefined;
		}

		const hex = getSessionAccentHex(key.sessionName, theme.getMajorThemeColorHexes(), key.accentSurfaceLuminance);
		if (!hex) {
			this.#workingMessageAccentCacheValue = undefined;
			return undefined;
		}

		const main = getSessionAccentAnsi(hex);
		const dim = getSessionAccentAnsi(adjustHsv(hex, { s: 0.55, v: 0.65 }));
		this.#workingMessageAccentCacheValue = main && dim ? { main, dim } : undefined;
		return this.#workingMessageAccentCacheValue;
	}

	startClockHeartbeat(): void {
		if (this.#clockTimer) return;
		this.#clockTimer = setInterval(() => {
			if (!this.#taskLabel) return;
			const elapsed = Date.now() - this.#taskStartedAt;
			if (elapsed >= 5000) {
				const nextClock = ` · ${formatClock(elapsed)}`;
				if (nextClock !== this.#workingClockText) {
					this.#workingClockText = nextClock;
					this.applyPendingWorkingMessage();
				}
			}
		}, 1000);
		this.#clockTimer.unref?.();
	}

	ensureLoadingAnimation(): void {
		if (!this.#host.loadingAnimation) {
			this.clearWorkingMessageAccentCache();
			this.#host.statusContainer.disposeChildren();
			const messageColorFn = ((message: string) =>
				renderWorkingMessage(
					message,
					this.#getWorkingMessageAccent(),
					this.#workingClockText,
				)) as LoaderMessageColorFn & {
				animated?: true;
			};
			if (shimmerEnabled()) messageColorFn.animated = true;
			this.#host.loadingAnimation = new Loader(
				this.#host.ui,
				spinner => {
					const living = livingSpinnerColor(theme);
					if (living) return `${living}${spinner}\x1b[39m`;
					const accent = this.#getWorkingMessageAccent();
					if (accent) return `${accent.main}${spinner}\x1b[39m`;
					return lavaText(spinner, theme, TERMINAL.trueColor);
				},
				messageColorFn,
				this.defaultWorkingMessage,
				getSymbolTheme().spinnerFrames,
			);
			this.#host.statusContainer.addChild(this.#host.loadingAnimation);
			this.setWorkingMessage(this.defaultWorkingMessage);
		} else if (!this.#host.statusContainer.children.includes(this.#host.loadingAnimation)) {
			this.#host.statusContainer.disposeChildren();
			this.#host.statusContainer.addChild(this.#host.loadingAnimation);
			this.#host.ui.requestRender();
		}
		this.applyPendingWorkingMessage();
		this.#host.todoBoardManager.renderTodoList();
	}

	clearWorkingLoader(): boolean {
		if (!this.#host.loadingAnimation) return false;
		this.#host.loadingAnimation.stop();
		this.#host.statusContainer.removeChild(this.#host.loadingAnimation);
		this.#host.loadingAnimation = undefined;
		return true;
	}

	stopLoadingAnimation(clearStatusContainer: boolean): void {
		const cleared = this.clearWorkingLoader();
		if (!cleared) return;
		this.clearWorkingMessageAccentCache();
		if (clearStatusContainer) {
			this.#host.statusContainer.disposeChildren();
		}
	}

	setWorkingMessage(message?: string): void {
		if (message) {
			const hint = interruptHint();
			const hasHint = message.endsWith(hint);
			const base = hasHint ? message.slice(0, -hint.length).trim() : message.trim();
			if (base !== this.#taskLabel) {
				this.#taskLabel = base;
				this.#taskHasHint = hasHint;
				this.#taskStartedAt = Date.now();
				this.#workingClockText = undefined;
			}
		} else {
			this.#taskLabel = undefined;
			this.#taskHasHint = false;
			this.#taskStartedAt = 0;
			this.#workingClockText = undefined;
		}
		this.applyPendingWorkingMessage();
	}

	applyPendingWorkingMessage(): void {
		if (!this.#host.loadingAnimation || !this.#taskLabel) return;
		let display = this.#taskLabel;
		if (this.#workingClockText) display += this.#workingClockText;
		if (this.#taskHasHint) display += interruptHint();
		this.#host.loadingAnimation.setMessage(display);
	}

	async withGuidedGoalProgress<T>(label: string, work: () => Promise<T>): Promise<T> {
		this.#host.statusContainer.disposeChildren();
		const loader = new Loader(
			this.#host.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${label} (esc to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.#host.statusContainer.addChild(loader);
		this.#host.ui.requestRender();
		try {
			return await work();
		} finally {
			loader.stop();
			this.#host.statusContainer.disposeChildren();
			this.#host.ui.requestRender();
		}
	}

	dispose(): void {
		if (this.#clockTimer) {
			clearInterval(this.#clockTimer);
			this.#clockTimer = undefined;
		}
		this.stopLoadingAnimation(false);
	}
}
