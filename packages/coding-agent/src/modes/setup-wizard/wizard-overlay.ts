import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	padding,
	padLineToWidth,
	routeSgrMouseInput,
	type SgrMouseEvent,
	TERMINAL,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { SGR_RESET } from "@veyyon/tui/ansi";
import { APP_NAME } from "@veyyon/utils";
import {
	layoutShortcutRows,
	type ModalShortcut,
	type ShortcutHitRect,
	type ShortcutLayoutRow,
} from "../components/modal-shell";
import { sunMark } from "../components/sun";
import { silverEscape } from "../components/welcome";
import { theme } from "../theme/theme";
import { renderSetupOutro, SETUP_OUTRO_MS } from "./scenes/outro";
import { renderSetupSplash, SETUP_SPLASH_MS, SETUP_TICK_MS } from "./scenes/splash";
import type {
	SetupKeyHint,
	SetupScene,
	SetupSceneController,
	SetupSceneHost,
	SetupSceneResult,
	SetupWizardContext,
} from "./scenes/types";

type WizardPhase = "splash" | "transition" | "scene" | "outro" | "done";

const SCENE_MARGIN_X = 4;
const MIN_CONTENT_WIDTH = 20;
/** Cross-dissolve duration from the splash into the first scene. */
const SCENE_TRANSITION_MS = 420;

/** In-scene hints for a scene that declares none: a list you move through and confirm. Scenes with other keys declare their own through */
const DEFAULT_SCENE_HINTS: readonly SetupKeyHint[] = [
	{ keys: "↑↓", label: "select" },
	{ keys: "enter", label: "confirm" },
];

/** Chip ids for the three keys the wizard itself acts on. */
const CHIP_BACK = "back";
const CHIP_SKIP = "skip";
const CHIP_LEAVE = "leave";

/** A hint as one chip label: the key, then what it does. */
function hintLabel(hint: SetupKeyHint): string {
	return `${hint.keys} ${hint.label}`;
}

function indentLine(line: string, width: number, indent: number): string {
	const prefix = padding(Math.min(indent, Math.max(0, width - 1)));
	return padLineToWidth(prefix + line, width);
}
/** Stable per-row jitter in [0,1) for the dissolve reveal order. */
function rowNoise(y: number): number {
	const h = Math.imul(y ^ 0x9e3779b9, 2654435761);
	return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Top-biased cross-dissolve between two equal-height frames. As `progress` (0..1) advances, each row flips from `from` to `to` once it crosses a per-row */
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
	/** Clickable footer chips of the last rendered frame, in screen coordinates. */
	#footerHitRects: ShortcutHitRect[] = [];
	#hoveredChipId: string | null = null;

	constructor(
		readonly ctx: SetupWizardContext,
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
			// Esc means the same thing on the splash as it does on every step: leave setup. It used to START the wizard here, alongside Enter and
			if (matchesKey(data, "escape")) {
				this.#beginOutro();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space")) {
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
		// While the scene is still animating in (the splash auto-advances after SETUP_SPLASH_MS), swallow confirm keys: a late "press enter to skip"
		if (
			this.#phase === "transition" &&
			(matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space"))
		) {
			return;
		}
		// Esc leaves setup. It used to fall through to the active scene, where no scene claimed it, so the only advertised way out was ctrl+c, a key
		if (matchesKey(data, "escape")) {
			if (this.#activeScene?.escapeAction?.()) {
				this.#activeScene.handleInput?.(data);
				return;
			}
			this.#beginOutro();
			return;
		}
		if (matchesKey(data, "right")) {
			this.#finishScene();
			return;
		}
		if (this.#sceneIndex > 0 && matchesKey(data, "left")) {
			this.#previousScene();
			return;
		}
		this.#activeScene?.handleInput?.(data);
	}

	/** Mouse handling for the fullscreen wizard (SGR tracking is on while the overlay holds the alternate screen). The frame paints from screen row 0, */
	#routeMouseEvent(event: SgrMouseEvent): void {
		if (this.#phase === "splash" || this.#phase === "outro") {
			if (!event.leftClick) return;
			if (this.#phase === "splash") this.#beginScene();
			else this.#complete();
			return;
		}
		if (this.#phase === "scene") {
			const chip = this.#chipAt(event.row, event.col);
			if (event.leftClick && chip) {
				this.#runFooterChip(chip.id);
				return;
			}
			if (event.motion) {
				const hovered = chip?.id ?? null;
				if (hovered !== this.#hoveredChipId) {
					this.#hoveredChipId = hovered;
					this.ctx.ui.requestRender();
				}
				if (chip) return;
			}
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
		// The wizard owns the whole viewport: every row is padded to the full width so the layout stays rectangular, and closed with a reset so no styling
		return this.#fitToScreen(lines, safeWidth, height).map(line => `${line}${SGR_RESET}`);
	}

	/** The progress breadcrumb: every step named, the current one lit. It used to be `█ ▓ · · · step 3 of 5`, which said where you were and */
	#renderProgress(width: number): string {
		const total = this.scenes.length;
		if (total <= 1) return "";
		const current = this.#sceneIndex;
		const labels = this.scenes.map(scene => scene.stepLabel ?? scene.title);
		const separator = theme.fg("dim", " › ");
		const trail = labels
			.map((label, index) =>
				index === current
					? theme.fg("accent", theme.bold(label))
					: theme.fg(index < current ? "muted" : "dim", label),
			)
			.join(separator);
		const count = theme.fg("dim", `${current + 1}/${total}`);
		const line = `${count}  ${trail}`;
		return visibleWidth(line) <= width ? line : theme.fg("dim", `step ${current + 1} of ${total}`);
	}

	/** The footer's key chips for the frame being rendered. The active scene owns the keys that act inside it (select, toggle, switch */
	#footerShortcuts(): ModalShortcut[] {
		const inScene = this.#activeScene?.keyHints?.() ?? DEFAULT_SCENE_HINTS;
		const isLastScene = this.#sceneIndex >= this.scenes.length - 1;
		const chips: ModalShortcut[] = inScene.map(hint => ({ label: hintLabel(hint) }));
		if (this.#sceneIndex > 0) {
			chips.push({ label: "← back", clickable: true, id: CHIP_BACK });
		}
		chips.push({ label: isLastScene ? "→ skip" : "→ skip step", clickable: true, id: CHIP_SKIP });
		const sceneEscape = this.#activeScene?.escapeAction?.();
		if (sceneEscape) {
			chips.push({ label: hintLabel(sceneEscape) });
			chips.push({ label: "ctrl+c leave setup", clickable: true, id: CHIP_LEAVE });
		} else {
			chips.push({ label: "esc leave setup", clickable: true, id: CHIP_LEAVE });
		}
		return chips;
	}

	/** The chip rows for this frame, wrapped to the width instead of cut. It used to be one row, truncated. At 80 columns the six hints of the */
	#footerLayout(width: number): ShortcutLayoutRow[] {
		return layoutShortcutRows(this.#footerShortcuts(), width, this.#hoveredChipId);
	}

	/** The clickable chip under a screen coordinate, if the pointer is on one. */
	#chipAt(row: number, col: number): ShortcutHitRect | undefined {
		return this.#footerHitRects.find(rect => rect.row === row && col >= rect.colStart && col < rect.colEnd);
	}

	/** A chip does exactly what its key does. */
	#runFooterChip(id: string): void {
		if (id === CHIP_BACK) this.#previousScene();
		else if (id === CHIP_SKIP) this.#finishScene();
		else if (id === CHIP_LEAVE) this.#beginOutro();
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
		// the breadcrumb, then the scene — nothing floats, everything breathes.
		const progress = this.#renderProgress(contentWidth);
		const header = [
			"",
			...sun.map(line => indentLine(line, width, marginX)),
			indentLine(`${silverEscape(0.55)}${theme.bold(APP_NAME.split("").join(" "))}\x1b[39m`, width, marginX),
			"",
			...(progress ? [indentLine(progress, width, marginX), ""] : []),
			indentLine(theme.bold(title), width, marginX),
		];
		if (subtitle) {
			// Wrapped, not cut. The approvals step's subtitle is 76 columns of prose and the content column is 72 at an 80-column terminal, so the
			for (const line of wrapTextWithAnsi(subtitle, contentWidth)) {
				header.push(indentLine(theme.fg("muted", line), width, marginX));
			}
		}
		header.push("");
		this.#bodyRowStart = header.length;

		const chipRows = this.#footerLayout(contentWidth);
		const footer = ["", ...chipRows.map(row => indentLine(row.styled, width, marginX))];
		const maxBodyLines = Math.max(0, height - header.length - footer.length);
		// The scene is told its row budget so it can size its own list to the viewport. A scene that still overruns is clipped, but never silently:
		const rendered = this.#activeScene?.render(contentWidth, maxBodyLines) ?? [];
		const body = this.#clipBody(rendered, maxBodyLines);
		const lines = header.concat(body.map(line => indentLine(line, width, marginX)));
		while (lines.length + footer.length < height) {
			lines.push("");
		}
		const fl = footer;
		for (let li = 0; li < fl.length; li++) lines.push(fl[li]!);
		this.#recordChipRects(chipRows, lines.length, marginX, height);
		return lines;
	}

	/** Where this frame put its clickable chips, so the next report can be turned back into the key the chip stands for. The chip strip closes the frame, so */
	#recordChipRects(rows: readonly ShortcutLayoutRow[], frameRows: number, marginX: number, height: number): void {
		this.#footerHitRects = [];
		const firstRow = frameRows - rows.length;
		for (let index = 0; index < rows.length; index++) {
			const row = firstRow + index;
			if (row < 0 || row >= height) continue;
			for (const chip of rows[index]?.chips ?? []) {
				if (!chip.clickable || chip.id === undefined) continue;
				this.#footerHitRects.push({
					id: chip.id,
					row,
					colStart: marginX + chip.offset,
					colEnd: marginX + chip.offset + chip.width,
				});
			}
		}
	}

	/** Fit a scene's rows into its budget, replacing the last kept row with a count when rows are dropped, so an overrun is visible instead of a frame */
	#clipBody(lines: readonly string[], budget: number): string[] {
		if (budget <= 0) return [];
		if (lines.length <= budget) return lines.slice();
		const hidden = lines.length - budget + 1;
		const notice = theme.fg("warning", `↓ ${hidden} more ${hidden === 1 ? "row" : "rows"} below`);
		return lines.slice(0, budget - 1).concat(notice);
	}

	#fitToScreen(lines: string[], width: number, height: number): string[] {
		const fitted = lines.slice(0, height).map(line => padLineToWidth(line, width));
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
			skipSetup: () => this.#beginOutro(),
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

	#previousScene(): void {
		if ((this.#phase !== "scene" && this.#phase !== "transition") || this.#sceneIndex <= 0) return;
		if (this.#lastWidth > 0) {
			this.#transitionFrom = this.#renderScene(this.#lastWidth, this.#lastHeight);
		}
		this.#unmountActiveScene();
		this.#sceneIndex -= 1;
		this.#mountSceneController("transition");
	}

	#unmountActiveScene(): void {
		this.#sceneFocusTarget = undefined;
		// A scene may return a promise here (the theme and glyph steps hand back a live preview asynchronously). Unmounting must not block the next scene's
		void this.#activeScene?.onUnmount?.();
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
