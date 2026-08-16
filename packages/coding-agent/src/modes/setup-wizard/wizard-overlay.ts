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

/**
 * In-scene hints for a scene that declares none: a list you move through and
 * confirm. Scenes with other keys declare their own through
 * {@link SetupSceneController.keyHints}.
 */
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
			// Esc means the same thing on the splash as it does on every step:
			// leave setup. It used to START the wizard here, alongside Enter and
			// Space, so the one key a user reaches for to get out of something was
			// the key that walked them further into it.
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
		// While the scene is still animating in (the splash auto-advances after
		// SETUP_SPLASH_MS), swallow confirm keys: a late "press enter to skip"
		// Enter must not activate the first control of a scene the user hasn't
		// seen — it used to launch the first provider's OAuth browser flow.
		if (
			this.#phase === "transition" &&
			(matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space"))
		) {
			return;
		}
		// Esc leaves setup. It used to fall through to the active scene, where no
		// scene claimed it, so the only advertised way out was ctrl+c, a key
		// users read as "kill the program", not "I'll finish this later". Leaving
		// is deliberately not confirmed: the complaint was that setup is hard to
		// get out of, and a "are you sure?" step makes that worse.
		//
		// A scene that is itself in a sub-state (browsing every theme, an OAuth
		// login in flight) claims Esc through `escapeAction`, and then gets the
		// keystroke. Without that claim the theme step's own "Esc returns to
		// curated choices" line ended the entire run, and the sign-in panel's
		// abort branch could never fire. The footer names whichever meaning is
		// live, so the key on screen is the key that acts.
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

	/**
	 * Mouse handling for the fullscreen wizard (SGR tracking is on while the
	 * overlay holds the alternate screen). The frame paints from screen row 0,
	 * so report coordinates index directly into the last rendered lines: scene
	 * body rows start at #bodyRowStart, indented by SCENE_MARGIN_X. Scenes
	 * that implement routeMouse get hit-tested events (wheel, hover, click);
	 * for the rest a wheel notch falls back to an arrow key. A left click
	 * advances the splash/outro like Enter. Raw reports never reach scene
	 * keyboard input.
	 *
	 * The footer chips are tested first, and only while a scene is settled: the
	 * strip is the wizard's own chrome, so a click there must not be read as a
	 * click into the scene column under it, and a chip pressed mid-dissolve would
	 * act on a step whose frame is still fading in. Hover over a chip lights it
	 * and stops there; hover anywhere else clears the highlight and falls through
	 * so the scene keeps its own hover.
	 */
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
		// The wizard owns the whole viewport: every row is padded to the full width
		// so the layout stays rectangular, and closed with a reset so no styling
		// leaks past the frame. No background escape is emitted for the ground, so
		// the terminal's own background shows through. A hardcoded ground overrides
		// the user's terminal theme and reads as a slab pasted over it on every
		// terminal that is not itself pure black.
		return this.#fitToScreen(lines, safeWidth, height).map(line => `${line}${SGR_RESET}`);
	}

	/**
	 * The progress breadcrumb: every step named, the current one lit.
	 *
	 * It used to be `█ ▓ · · ·   step 3 of 5`, which said where you were and
	 * nothing about where you were going: five identical marks in a private
	 * glyph vocabulary, so the only readable part was the count. Naming the steps
	 * means a user can see what onboarding is going to ask before it asks, and
	 * can tell whether the thing they came for is still ahead.
	 *
	 * Empty for a single-scene wizard — one lone name next to "step 1 of 1" is
	 * not progress. Falls back to the bare count when the names cannot fit, since
	 * a breadcrumb cut mid-word is worse than a count.
	 */
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

	/**
	 * The footer's key chips for the frame being rendered.
	 *
	 * The active scene owns the keys that act inside it (select, toggle, switch
	 * panel); the wizard owns the keys that move the run, because only the wizard
	 * knows whether another step follows.
	 *
	 * The labels name what each key actually does, which the old line did not.
	 * `→` does not apply the step: `#finishScene` advances the index and the
	 * scene commits nothing, so it is a skip, and calling it "next" next to
	 * "enter confirm" left no way to tell which one kept your choice. And the
	 * only key that ended the run was advertised as "ctrl+c skip", conflating
	 * "skip this step" with "leave setup" under the key that means "kill it".
	 *
	 * When the active scene claims Esc for a sub-state of its own, its meaning
	 * takes the Esc slot and `ctrl+c leave setup` is named instead, because the
	 * user must always be able to read one key that ends the run.
	 *
	 * Only the three keys the WIZARD acts on are clickable. A scene hint names a
	 * key the scene reads, and the wizard has no way to press it on the reader's
	 * behalf: turning `↑↓ select` into a click target would mean guessing which
	 * keystroke a chip stands for and sending it into a scene that never asked.
	 */
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

	/**
	 * The chip rows for this frame, wrapped to the width instead of cut.
	 *
	 * It used to be one row, truncated. At 80 columns the six hints of the
	 * subagents and import steps ran past the frame, and what fell off the end
	 * was `esc leave setup`: the one hint a stuck user needs was the first to
	 * go, on exactly the terminal size where being stuck is most likely. The
	 * shared chip packer breaks between chips, never inside one, and it is the
	 * same one every card footer uses, so a wizard row and a card row wrap the
	 * same way at the same width.
	 *
	 * The count is computed before the body budget, so a second row costs the
	 * scene a row rather than overflowing the frame.
	 */
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
			// Wrapped, not cut. The approvals step's subtitle is 76 columns of
			// prose and the content column is 72 at an 80-column terminal, so the
			// sentence that names where the setting lives afterwards ended as
			// "…for one session with /permissi…".
			for (const line of wrapTextWithAnsi(subtitle, contentWidth)) {
				header.push(indentLine(theme.fg("muted", line), width, marginX));
			}
		}
		header.push("");
		this.#bodyRowStart = header.length;

		const chipRows = this.#footerLayout(contentWidth);
		const footer = ["", ...chipRows.map(row => indentLine(row.styled, width, marginX))];
		const maxBodyLines = Math.max(0, height - header.length - footer.length);
		// The scene is told its row budget so it can size its own list to the
		// viewport. A scene that still overruns is clipped, but never silently:
		// the last row becomes a count of what is off-screen. Before this, the
		// budget was applied here as a bare `slice`, so a provider list, a theme
		// list and every wrapped description simply ended mid-row with nothing to
		// say more existed — the "you can't see all of it" report.
		const rendered = this.#activeScene?.render(contentWidth, maxBodyLines) ?? [];
		const body = this.#clipBody(rendered, maxBodyLines);
		const lines = [...header, ...body.map(line => indentLine(line, width, marginX))];
		while (lines.length + footer.length < height) {
			lines.push("");
		}
		lines.push(...footer);
		this.#recordChipRects(chipRows, lines.length, marginX, height);
		return lines;
	}

	/**
	 * Where this frame put its clickable chips, so the next report can be turned
	 * back into the key the chip stands for. The chip strip closes the frame, so
	 * the first chip row is the frame height minus the number of chip rows, and a
	 * chip's screen column is the scene margin plus its offset within the row.
	 * Anything past the visible height is dropped rather than recorded: those
	 * rows are about to be cut by `#fitToScreen`, and a rect for a row nobody can
	 * see is a click target on empty terminal.
	 *
	 * Both halves of the chip filter are meant: only one of them can fail today,
	 * because `layoutShortcutRows` computes `clickable` as `Boolean(s.clickable
	 * && s.id)`, so a chip carrying an id is clickable and one without an id is
	 * not. A chip declared with an id and no `clickable` flag is expressible and
	 * must never become a target, so the flag stays the primary test and the id
	 * check narrows it for the rect.
	 */
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

	/**
	 * Fit a scene's rows into its budget, replacing the last kept row with a
	 * count when rows are dropped, so an overrun is visible instead of a frame
	 * that just stops. A budget of one row cannot hold both content and a
	 * notice, so it shows the notice: knowing rows are hidden matters more than
	 * one arbitrary row of them.
	 */
	#clipBody(lines: readonly string[], budget: number): string[] {
		if (budget <= 0) return [];
		if (lines.length <= budget) return [...lines];
		const hidden = lines.length - budget + 1;
		const notice = theme.fg("warning", `↓ ${hidden} more ${hidden === 1 ? "row" : "rows"} below`);
		return [...lines.slice(0, budget - 1), notice];
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
		// A scene may return a promise here (the theme and glyph steps hand back a
		// live preview asynchronously). Unmounting must not block the next scene's
		// mount on it, so the promise is intentionally dropped; the scene owns
		// reporting its own failure.
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
