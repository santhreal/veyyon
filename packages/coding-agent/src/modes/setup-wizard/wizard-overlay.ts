import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/pi-tui";
import { APP_NAME } from "@veyyon/pi-utils";
import { sunMark } from "../components/sun";
import { silverEscape } from "../components/welcome";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { renderSetupOutro, SETUP_OUTRO_MS } from "./scenes/outro";
import { renderSetupSplash, SETUP_SPLASH_MS, SETUP_TICK_MS } from "./scenes/splash";
import type { SetupScene, SetupSceneController, SetupSceneHost, SetupSceneResult } from "./scenes/types";

type WizardPhase = "splash" | "transition" | "scene" | "outro" | "done";

const SCENE_MARGIN_X = 4;
const MIN_CONTENT_WIDTH = 20;
/** Cross-dissolve duration from the splash into the first scene. */
const SCENE_TRANSITION_MS = 420;

function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

function indentLine(line: string, width: number, indent: number): string {
	const prefix = padding(Math.min(indent, Math.max(0, width - 1)));
	return clampLine(prefix + line, width);
}
/** Stable per-row jitter in [0,1) for the dissolve reveal order. */
function rowNoise(y: number): number {
	const h = Math.imul(y ^ 0x9e3779b9, 2654435761);
	return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/**
 * Top-biased cross-dissolve between two equal-height frames. As `progress`
 * (0..1) advances, each row flips from `from` to `to` once it crosses a per-row
 * threshold — top rows reveal first (so the scene's mark/header materializes
 * before the splash water below it), with a little jitter for an organic edge.
 */
function dissolveFrames(from: string[], to: string[], progress: number, height: number): string[] {
	const eased = progress * progress * (3 - 2 * progress);
	const denom = Math.max(1, height - 1);
	const out: string[] = [];
	for (let y = 0; y < height; y++) {
		const threshold = 0.78 * (y / denom) + 0.22 * rowNoise(y);
		out.push((eased >= threshold ? to[y] : from[y]) ?? "");
	}
	return out;
}

export class SetupWizardComponent implements Component, OverlayFocusOwner {
	#phase: WizardPhase = "splash";
	#phaseStartedAt = performance.now();
	#sceneIndex = 0;
	#activeScene: SetupSceneController | undefined;
	#timer: NodeJS.Timeout | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;
	/** Screen row where the active scene's body began in the last rendered frame. */
	#bodyRowStart = 0;
	/** Left margin of the scene column in the last rendered frame. */
	#bodyMarginX = SCENE_MARGIN_X;
	/** Frame to dissolve FROM when moving scene-to-scene. */
	#transitionFrom: string[] | undefined;
	#lastWidth = 0;
	#lastHeight = 0;
	#sceneFocusTarget: Component | undefined;

	constructor(
		readonly ctx: InteractiveModeContext,
		readonly scenes: readonly SetupScene[],
	) {}

	run(): Promise<void> {
		this.#phase = this.scenes.length === 0 ? "outro" : "splash";
		this.#phaseStartedAt = performance.now();
		this.#startTimer();
		this.ctx.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopTimer();
		this.#unmountActiveScene();
	}

	invalidate(): void {
		this.#activeScene?.invalidate?.();
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		if (this.#sceneFocusTarget !== component) return false;
		return true;
	}

	handleInput(data: string): void {
		if (this.#phase === "done") return;
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				this.#routeMouseEvent(event);
			});
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.#beginOutro();
			return;
		}
		if (this.#phase === "splash") {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				matchesKey(data, "space") ||
				matchesKey(data, "escape")
			) {
				this.#beginScene();
			}
			return;
		}
		if (this.#phase === "outro") {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				matchesKey(data, "space") ||
				matchesKey(data, "escape")
			) {
				this.#complete();
			}
			return;
		}
		this.#activeScene?.handleInput?.(data);
	}

	/**
	 * Mouse handling for the fullscreen wizard (SGR tracking is on while the
	 * overlay holds the alternate screen). The frame paints from screen row 0,
	 * so report coordinates index directly into the last rendered lines: scene
	 * body rows start at #bodyRowStart, indented by SCENE_MARGIN_X. Scenes
	 * that implement routeMouse get hit-tested events (wheel, hover, click);
	 * for the rest a wheel notch falls back to an arrow key. A left click
	 * advances the splash/outro like Enter. Raw reports never reach scene
	 * keyboard input.
	 */
	#routeMouseEvent(event: SgrMouseEvent): void {
		if (this.#phase === "splash" || this.#phase === "outro") {
			if (!event.leftClick) return;
			if (this.#phase === "splash") this.#beginScene();
			else this.#complete();
			return;
		}
		const scene = this.#activeScene;
		if (!scene) return;
		if (scene.routeMouse) {
			scene.routeMouse(event, event.row - this.#bodyRowStart, event.col - this.#bodyMarginX);
			return;
		}
		if (event.wheel !== null) {
			scene.handleInput?.(event.wheel === -1 ? "\x1b[A" : "\x1b[B");
		}
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.ctx.ui.terminal.rows);
		let lines: string[];
		switch (this.#phase) {
			case "splash":
				lines = renderSetupSplash(safeWidth, height, performance.now() - this.#phaseStartedAt);
				break;
			case "transition": {
				const elapsed = performance.now() - this.#phaseStartedAt;
				const progress = Math.min(1, elapsed / SCENE_TRANSITION_MS);
				const from = this.#transitionFrom ?? renderSetupSplash(safeWidth, height, SETUP_SPLASH_MS + elapsed);
				const scene = this.#renderScene(safeWidth, height);
				lines = dissolveFrames(from, scene, progress, height);
				break;
			}
			case "outro":
				lines = renderSetupOutro(safeWidth, height, performance.now() - this.#phaseStartedAt);
				break;
			case "scene":
				lines = this.#renderScene(safeWidth, height);
				break;
			case "done":
				lines = [];
				break;
		}
		this.#lastWidth = safeWidth;
		this.#lastHeight = height;
		return this.#fitToScreen(lines, safeWidth, height);
	}

	/** Step dots: solid for steps done, an ember core for the current, dots ahead. */
	#renderProgress(): string {
		const total = this.scenes.length;
		const current = this.#sceneIndex + 1;
		const dots: string[] = [];
		for (let i = 0; i < total; i++) {
			dots.push(
				i < current - 1
					? theme.fg("accent", "█")
					: i === current - 1
						? theme.fg("accent", "▓")
						: theme.fg("dim", "·"),
			);
		}
		return `${dots.join(" ")}   ${theme.fg("dim", `step ${current} of ${total}`)}`;
	}

	#renderScene(width: number, height: number): string[] {
		const scene = this.scenes[this.#sceneIndex];
		const title = this.#activeScene?.title ?? scene?.title ?? "Setup";
		const subtitle = this.#activeScene?.subtitle;
		const contentWidth = Math.min(76, Math.max(MIN_CONTENT_WIDTH, width - SCENE_MARGIN_X * 2));
		const marginX = Math.max(0, Math.floor((width - contentWidth) / 2));
		this.#bodyMarginX = marginX;
		const sun = sunMark(15, 5, { trueColor: TERMINAL.trueColor });
		// One centered column: the sun, the wordmark in the terminal's own font,
		// the step dots, then the scene — nothing floats, everything breathes.
		const header = [
			"",
			...sun.map(line => indentLine(line, width, marginX)),
			indentLine(`${silverEscape(0.55)}${theme.bold(APP_NAME.split("").join(" "))}\x1b[39m`, width, marginX),
			"",
			indentLine(this.#renderProgress(), width, marginX),
			"",
			indentLine(theme.bold(title), width, marginX),
		];
		if (subtitle) {
			header.push(indentLine(theme.fg("muted", subtitle), width, marginX));
		}
		header.push("");
		this.#bodyRowStart = header.length;

		const footer = [
			"",
			indentLine(theme.fg("dim", "↑↓ select  ·  enter confirm  ·  esc skip  ·  ctrl+c exit"), width, marginX),
		];
		const maxBodyLines = Math.max(0, height - header.length - footer.length);
		const body = this.#activeScene?.render(contentWidth).slice(0, maxBodyLines) ?? [];
		const lines = [...header, ...body.map(line => indentLine(line, width, marginX))];
		while (lines.length + footer.length < height) {
			lines.push("");
		}
		lines.push(...footer);
		return lines;
	}

	#fitToScreen(lines: string[], width: number, height: number): string[] {
		const fitted = lines.slice(0, height).map(line => clampLine(line, width));
		while (fitted.length < height) {
			fitted.push(padding(width));
		}
		return fitted;
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			if (this.#disposed) return;
			const elapsed = performance.now() - this.#phaseStartedAt;
			if (this.#phase === "splash" && elapsed >= SETUP_SPLASH_MS) {
				this.#beginScene();
			} else if (this.#phase === "transition" && elapsed >= SCENE_TRANSITION_MS) {
				this.#phase = "scene";
				this.#phaseStartedAt = performance.now();
				this.ctx.ui.requestRender();
			} else if (this.#phase === "outro" && elapsed >= SETUP_OUTRO_MS) {
				this.#complete();
			} else {
				this.ctx.ui.requestRender();
			}
		}, SETUP_TICK_MS);
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#mountSceneController(targetPhase: "scene" | "transition"): void {
		if (this.#disposed) return;
		this.#unmountActiveScene();
		if (this.#sceneIndex >= this.scenes.length) {
			this.#beginOutro();
			return;
		}
		const scene = this.scenes[this.#sceneIndex];
		const host: SetupSceneHost = {
			ctx: this.ctx,
			requestRender: () => this.ctx.ui.requestRender(),
			finish: (_result: SetupSceneResult) => this.#finishScene(),
			setFocus: component => {
				this.#sceneFocusTarget = component ?? undefined;
				this.ctx.ui.setFocus(component);
			},
			restoreFocus: () => {
				this.#sceneFocusTarget = undefined;
				this.ctx.ui.setFocus(this);
			},
		};
		this.#activeScene = scene.mount(host);
		this.#phase = targetPhase;
		this.#phaseStartedAt = performance.now();
		this.#sceneFocusTarget = undefined;
		this.ctx.ui.setFocus(this);
		void this.#activeScene.onMount?.();
		this.ctx.ui.requestRender();
	}

	/** Enter the first scene through a dissolve from the splash. */
	#beginScene(): void {
		this.#transitionFrom = undefined;
		this.#mountSceneController("transition");
	}

	#finishScene(): void {
		if (this.#phase !== "scene" && this.#phase !== "transition") return;
		// Dissolve into the next scene: capture this frame before unmounting.
		if (this.#lastWidth > 0 && this.#sceneIndex + 1 < this.scenes.length) {
			this.#transitionFrom = this.#renderScene(this.#lastWidth, this.#lastHeight);
			this.#unmountActiveScene();
			this.#sceneIndex += 1;
			this.#mountSceneController("transition");
			return;
		}
		this.#transitionFrom = undefined;
		this.#unmountActiveScene();
		this.#sceneIndex += 1;
		this.#mountSceneController("scene");
	}

	#unmountActiveScene(): void {
		this.#sceneFocusTarget = undefined;
		this.#activeScene?.onUnmount?.();
		this.#activeScene?.dispose?.();
		this.#activeScene = undefined;
	}

	#beginOutro(): void {
		if (this.#phase === "done") return;
		this.#unmountActiveScene();
		this.#phase = "outro";
		this.#phaseStartedAt = performance.now();
		this.ctx.ui.setFocus(this);
		this.#startTimer();
		this.ctx.ui.requestRender();
	}

	#complete(): void {
		if (this.#phase === "done") return;
		this.#phase = "done";
		this.#stopTimer();
		this.#done.resolve();
	}
}
