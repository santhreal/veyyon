/**
 * The launch card, painted before the session exists.
 *
 * `InteractiveMode` builds the TUI in its constructor and mounts the tree in
 * `init()`, and both run after `createAgentSession`: the plugin-root preload,
 * extension and skill discovery, the model registry and the MCP connections
 * all resolve in front of the first frame, and the terminal stays blank for the
 * whole of it (290ms of a 319ms boot, measured on this workspace). Nothing on
 * the card needs a session. The sun, the wordmark, the version and the tip are
 * known as soon as settings and the theme are up.
 *
 * So the frame is painted here, and the mode adopts what this module built
 * instead of building its own: the same TUI, the same card -- whose model line
 * starts from what the last launch of this project recorded and is confirmed
 * through `WelcomeComponent.setModel` once the session resolves it, and whose
 * recent sessions arrive through `setRecentSessions` -- and the same composer.
 *
 * The composer is the REAL one. An earlier shape painted a static picture of a
 * composer and held every keystroke in a gate until the mode could build the
 * editor, which meant the rows on screen were a promise rather than an input:
 * the draft had to be echoed by hand, backspace had to be reimplemented, and
 * the held text had to be transplanted at mount. Building the editor here
 * costs a few milliseconds and deletes all of it. What is on screen at the
 * first paint takes keystrokes, and the mode's own zone mounts its status
 * line, footline and shortcuts AROUND that editor without ever replacing it.
 *
 * One TUI per process is a hard constraint -- `terminal.start` puts stdin in
 * raw mode and installs the reader, so a second instance reads the same fd --
 * and the tty handover moves here with it. The mode reads the frame through
 * {@link takeFirstFrame} rather than a constructor argument, for the same
 * reason the terminal layer keeps its active instance at module level: there is
 * one screen, and whoever owns it owns it for the process.
 */
import { Spacer } from "@veyyon/tui/components/spacer";
// Leaves, not the `@veyyon/tui` barrel. The barrel re-exports every component in the library, and
// the first frame paints before any of them exist.
import { matchesKey } from "@veyyon/tui/keys";
import { planPaintGround } from "@veyyon/tui/paint-ground";
import { ProcessTerminal } from "@veyyon/tui/terminal";
import { setTerminalTextSizing, TERMINAL } from "@veyyon/tui/terminal-capabilities";
import { type Component, Container, TUI } from "@veyyon/tui/tui";
import { setTuiTight } from "@veyyon/tui/utils";
import * as logger from "@veyyon/utils/logger";
import { settings } from "../config/settings-instance";
import { clearFirstFrameRecording, recordFirstFrame, takeReplayedFirstFrame } from "../startup/first-frame-replay";
import {
	applyComposerChrome,
	computeEditorMaxHeight,
	mountLaunchComposer,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "./components/composer-chrome";
import { CustomEditor } from "./components/custom-editor";
import { setLaunchTip } from "./components/launch-tip";
import { WelcomeComponent } from "./components/welcome";
import { HomeAnchorLayout } from "./controllers/home-anchor-layout";
import { launchModelLabel, readLaunchFacts } from "./launch-facts";
import { applyGroundPaint, setDetectedTerminalGround } from "./theme/ground-tints";
import { getEditorTheme, theme } from "./theme/theme";
import { consumeRelaunchMarker, flushPendingTtyInput } from "./tty-input-flush";

/** Inputs used to decide whether the launch card may be painted this early. */
export interface FirstFrameDecisionOptions {
	readonly isInteractive: boolean;
	/** rpc / rpc-ui / acp own stdin and never paint a home screen. */
	readonly protocolMode: boolean;
	/** `startup.quiet`: the launch has no hero to paint. */
	readonly quiet: boolean;
	/** The startup splash owns the screen for its whole run. */
	readonly splash: boolean;
	/** Onboarding -- forced, or a stale setup generation -- owns the screen. */
	readonly setupWizard: boolean;
	readonly stdinIsTTY: boolean | undefined;
	readonly stdoutIsTTY: boolean | undefined;
	/** Restoring a session (--resume, --continue, --fork) skips the welcome hero. */
	readonly resuming?: boolean;
}

/** True only for a normal interactive TTY launch that lands on the home screen. */
export function shouldPaintFirstFrame(options: FirstFrameDecisionOptions): boolean {
	if (!options.isInteractive || options.protocolMode) return false;
	if (options.quiet || options.splash || options.setupWizard || options.resuming) return false;
	return options.stdinIsTTY === true && options.stdoutIsTTY === true;
}

/** What the mode adopts: a started screen with the launch card already on it. */
export interface FirstFrame {
	/** The one TUI of this process. */
	readonly ui: TUI;
	/**
	 * The card on screen. The mode remounts this instance rather than building
	 * a second one, so the sun, the tip and the row count do not change under
	 * the operator when the session lands.
	 */
	readonly hero: WelcomeComponent;
	/**
	 * The composer on screen, focused and taking keystrokes. The mode adopts
	 * this editor instead of building one, so a character typed at the card is
	 * already in the draft the session comes up behind -- there is nothing to
	 * hold and nothing to transplant.
	 */
	readonly editor: CustomEditor;
	/**
	 * The container {@link editor} is mounted in. `mountComposerZone` takes it
	 * as the zone's `editorContainer`, so the editor moves from the launch
	 * chrome to the mode's zone without being detached from its parent.
	 */
	readonly editorContainer: Container;
	/**
	 * Settle what the next launch replays: record this card, keep a recording this card confirmed,
	 * or drop one it corrected.
	 *
	 * Called once the paint has reached the terminal, because that is when the bytes are complete
	 * and the composed rows are final.
	 */
	settleReplayRecording(): void;
	/** Drop the launch rows, leaving an empty root for the mode's own tree. Idempotent. */
	release(): void;
	/**
	 * Spend the loop turns that let input queued before the card reach the
	 * composer, and report whether anything arrived.
	 *
	 * The card is composed inside {@link paintFirstFrame} and its bytes are
	 * queued, so the frame the operator sees was built before the reader ever
	 * produced data: a key pressed during exec is still sitting in the tty
	 * buffer at that point, and one check-phase turn does not collect it
	 * because the loop has not reached poll. The caller then evaluates the main
	 * module, which holds the loop long enough that a pty measured the card at
	 * 156ms and the character typed before it at 312ms — a composer that is on
	 * screen and visibly ignoring the operator for a sixth of a second.
	 *
	 * Awaiting this spends one loop turn so the reader delivers, and a second
	 * so the redraw is written. When nothing was typed it costs those two turns
	 * and draws nothing.
	 */
	settleQueuedInput(): Promise<boolean>;
}

let painted: FirstFrame | undefined;

/**
 * Build the screen, paint the launch card on it, and start reading the
 * terminal. The frame is held for {@link takeFirstFrame}; the caller keeps
 * nothing.
 */
export function paintFirstFrame(version: string): FirstFrame {
	setTuiTight(settings.get("tui.tight"));
	setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.textSizing);
	const ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
	ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
	ui.setScrollbackRebuild(settings.get("tui.scrollbackRebuild"));
	ui.setScrollIsolation(settings.get("tui.scrollIsolation"));

	// The model line the last launch recorded. Resolving a display name needs the
	// catalog, which this path may not load, and the empty strings this used to
	// pass rendered as `no model yet · /login` -- an alarming thing to tell an
	// operator who is logged in, and a row the session then rewrote 600ms later.
	// Absent a recording the configured role's own tail is stated instead, so the
	// placeholder is reached only when no model is configured and it is true.
	// The screen the replay left, if this launch replayed one. Taken here, before the card is built,
	// because the card has to be built to MATCH it: same tip, or the three tip rows rewrite
	// themselves the moment the real card composes.
	const replayed = takeReplayedFirstFrame();
	const adopted =
		replayed !== undefined &&
		replayed.screen.width === ui.terminal.columns &&
		replayed.screen.height === ui.terminal.rows
			? replayed
			: undefined;
	if (adopted) setLaunchTip(adopted.tip);
	const { providerName, terminalGround } = readLaunchFacts();
	// The ground every structural color is derived from is settled below, before the first paint,
	// out of what this terminal last reported.
	const hero = new WelcomeComponent(version, launchModelLabel(), providerName ?? "");
	const layout = new HomeAnchorLayout({ ui, transcriptChildCount: () => 0, hasHero: () => true });
	// The composer, live. Dressed through the one chrome owner and sized through
	// the one height policy, so it is the same composer the mode goes on using
	// rather than a lookalike that has to be reconciled with one.
	const editor = new CustomEditor(getEditorTheme());
	applyComposerChrome(editor, resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE));
	editor.setUseTerminalCursor(ui.getShowHardwareCursor());
	editor.setMaxHeight(computeEditorMaxHeight(ui.terminal.rows));
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const children: Component[] = [layout.topFill, new Spacer(1), hero, new Spacer(1), layout.bottomFill];
	// The composer zone at rest, painted NOW. Centring is a share of the slack
	// below the card (HomeAnchorLayout), so the zone's height has to be on
	// screen before the mode's zone exists: the launch composer occupies the
	// resting zone's exact row count, and `mountComposerZone` swaps its own
	// chrome into those rows around this same editor rather than arriving
	// under them.
	mountLaunchComposer({ addChild: child => children.push(child) }, editorContainer);
	for (const child of children) ui.addChild(child);
	// Keystrokes have somewhere to land from here on: `TUI` forwards input to
	// the focused component, and the focused component is the composer the
	// operator is looking at.
	ui.setFocus(editor);
	// No frame has been composed, so this measures the children directly.
	layout.sync(true);

	// Set only by the Windows relaunch degrade below; released at mount.
	let discardUntilMount: (() => void) | undefined;

	// The tty handover, which `InteractiveMode.init` used to own. Two different
	// things can be sitting in the kernel's input queue by now, and the bytes do
	// not say which:
	//
	//   A RELAUNCH (`/profile <name>` respawns the CLI) leaves whatever arrived
	//   while nobody was reading fd 0. That backlog belongs to the session that
	//   exited, and a queued carriage return in it submits a turn nobody typed,
	//   so it is dropped outright.
	//
	//   AN ORDINARY LAUNCH queues what the operator typed at a terminal that is
	//   not painting yet. Startup runs for most of a second before the card
	//   appears, and flushing here destroyed every keystroke inside that window:
	//   the characters were gone, not late, so the composer came up empty and
	//   the session read as unresponsive.
	//
	// Only who started the process separates them, which is what the relaunch
	// marker records. An ordinary launch installs no gate at all: the composer
	// below is live, so the queue lands in the draft the operator is looking at.
	const relaunched = consumeRelaunchMarker();
	const flushed = relaunched ? flushPendingTtyInput() : false;
	// A relaunch that could not flush (Windows has no termios) cannot tell the
	// stale queue from typing, so it degrades to discarding both: everything is
	// swallowed until the mode releases the gate, except ctrl+c, which stays
	// live so a launch can be aborted.
	if (relaunched && !flushed) {
		logger.debug("No tty input flush available at startup; discarding buffered input until mount completes");
		discardUntilMount = ui.addInputListener(data => (matchesKey(data, "ctrl+c") ? undefined : { consume: true }));
	}
	// Set only while the card owns the screen; the mode takes the ground over at mount.
	let mounted = true;
	// The ground, and everything that resolves against it, settled in one place.
	//
	// `ui.start()` below is what SENDS the OSC 11 query, so the terminal cannot have answered when
	// the card is painted, and the answer decides three things at once: the hairline above the
	// composer, the composer outline and the transcript rules, which are mixed out of the ground;
	// and, under `auto`, whether the theme ground is painted over the terminal's own at all.
	//
	// Nothing consumed that answer until the mode subscribed, half a second later. Measured on a
	// pty that answers OSC 11 like a terminal: the hairline was drawn from the static `borderMuted`
	// token, `#202329`, at 46ms and restyled to the ground-derived `#2a2e33` at 615ms, so one line
	// on a settled screen changed shade under the operator.
	//
	// So the card states the ground its terminal reported last time and settles the whole decision
	// BEFORE the paint. The recording is per terminal and this is the same value the answer is
	// about to confirm; when it does not confirm it, the answer wins on the very next frame rather
	// than at mount.
	const settleGround = (): void => {
		const ground = ui.terminal.backgroundColor ?? terminalGround ?? undefined;
		setDetectedTerminalGround(ground);
		applyGroundPaint(planPaintGround(settings.get("tui.paintGround"), theme.getGroundHex(), ground), ui.terminal);
	};
	settleGround();
	ui.terminal.onBackgroundColorChange?.(() => {
		if (!mounted) return;
		settleGround();
		ui.requestRender();
	});
	// Adopting the replayed screen makes the render below a DIFF against those rows instead of a
	// full paint, so an unchanged launch writes nothing at all and a changed one writes only the
	// rows that changed.
	if (adopted) ui.adoptPaintedWindow(adopted.screen);
	// The first paint always clears the viewport (ED 2) so the card never
	// appends over the previous run's frame. Erasing the terminal's saved
	// scrollback (ED 3) also takes whatever the operator had on screen before
	// launch, so it happens only when they asked for it. An adopted screen was
	// cleared by the replayed bytes themselves, and clearing again would be the
	// full repaint the adoption exists to avoid.
	ui.start({ clearScrollback: adopted === undefined && settings.get("startup.clearScrollback") });
	// Everything the render writes from here, which is the recording the next launch replays. The
	// wrapper goes on AFTER `start`, so the terminal setup it emits -- the capability queries above
	// all -- stays out: replaying a query means a second answer arriving with nobody expecting it.
	let captured = "";
	const terminal = ui.terminal;
	const passThrough = terminal.write.bind(terminal);
	terminal.write = (data: string): void => {
		captured += data;
		passThrough(data);
	};
	const stopCapture = (): void => {
		terminal.write = passThrough;
	};

	const frame: FirstFrame = {
		ui,
		hero,
		editor,
		editorContainer,
		release(): void {
			discardUntilMount?.();
			discardUntilMount = undefined;
			if (!mounted) return;
			mounted = false;
			for (const child of children) ui.removeChild(child);
		},
		settleReplayRecording(): void {
			stopCapture();
			const screen = ui.paintedScreen();
			if (adopted === undefined) {
				recordFirstFrame({
					bytes: captured,
					cols: ui.terminal.columns,
					rows: ui.terminal.rows,
					screen,
					tip: hero.tip ?? "",
				});
				return;
			}
			const window = screen.window;
			const previous = adopted.screen.window;
			// The screen was replayed and the real card agrees with it row for row, so the recording
			// still describes what a launch paints and stays.
			if (window.length === previous.length && window.every((row, at) => row === previous[at])) return;
			// It disagreed, so the operator just watched those rows correct themselves. The bytes that
			// would record the NEW card were never emitted -- only the diff was -- so the recording is
			// dropped and the next launch composes one and records it. One corrected launch, not a run
			// of them.
			const at = window.findIndex((row, index) => row !== previous[index]);
			logger.debug("First-frame recording dropped: the composed card disagreed with the replay", {
				row: at === -1 ? window.length : at,
				replayed: at === -1 ? undefined : previous[at],
				composed: at === -1 ? undefined : window[at],
				replayedRows: previous.length,
				composedRows: window.length,
			});
			clearFirstFrameRecording();
		},
		async settleQueuedInput(): Promise<boolean> {
			// A check-phase turn, so the loop reaches poll and the reader hands
			// over anything the operator typed before the card existed. The
			// editor takes it as ordinary input and asks for a render.
			const delivered = Promise.withResolvers<void>();
			setImmediate(delivered.resolve);
			await delivered.promise;
			if (editor.getText().length === 0) return false;
			// Forced rather than trusted: the editor's own render request is
			// subject to the throttle, and this call is the one that has to be
			// on screen before the caller blocks the loop again.
			ui.requestRender(true);
			const written = Promise.withResolvers<void>();
			setImmediate(written.resolve);
			await written.promise;
			return true;
		},
	};
	painted = frame;
	return frame;
}

/**
 * The painted frame, once. A second interactive mode in the same process (a
 * test harness, a relaunch that got as far as constructing one) builds its own
 * screen rather than adopting a card that is no longer on it.
 */
export function takeFirstFrame(): FirstFrame | undefined {
	const frame = painted;
	painted = undefined;
	return frame;
}
