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
 * and recent session arrive through `WelcomeComponent.setModel` and
 * `setRecentSessions` once the session resolves them -- and the same composer.
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
import type { Component } from "@veyyon/tui/core/component-types";
import { Container } from "@veyyon/tui/core/container";
import { TUI } from "@veyyon/tui/core/tui";
import { ProcessTerminal } from "@veyyon/tui/terminal";
import { setTerminalTextSizing, TERMINAL } from "@veyyon/tui/terminal-capabilities";
import { matchesKey } from "@veyyon/utils/keys";
import * as logger from "@veyyon/utils/logger";
import { planPaintGround } from "@veyyon/utils/paint-ground";
import { setTuiTight } from "@veyyon/utils/tight-mode";
import { settings } from "../../config/settings-instance";
import { applyGroundPaint, setDetectedTerminalGround } from "../../theme/ground-tints";
import { getEditorTheme, theme } from "../../theme/theme";
import {
	applyComposerChrome,
	computeEditorMaxHeight,
	mountLaunchComposer,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "./components/composer/composer-chrome";
import { CustomEditor } from "./components/composer/custom-editor";
import { WelcomeComponent } from "./components/dialogs/welcome";
import { HomeAnchorLayout } from "./controllers/home-anchor-layout";
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

	const hero = new WelcomeComponent(version, "", "");
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
	// The first paint always clears the viewport (ED 2) so the card never
	// appends over the previous run's frame. Erasing the terminal's saved
	// scrollback (ED 3) also takes whatever the operator had on screen before
	// launch, so it happens only when they asked for it.
	ui.start({ clearScrollback: settings.get("startup.clearScrollback") });
	// The theme ground goes on with the card, not 300ms after it. `auto` needs
	// the terminal's OSC 11 answer, which has not arrived this early, so it
	// paints nothing here and the mode applies it when the report lands; the
	// modes that need no report (`always`, `never`) are settled now.
	setDetectedTerminalGround(ui.terminal.backgroundColor);
	applyGroundPaint(
		planPaintGround(settings.get("tui.paintGround"), theme.getGroundHex(), ui.terminal.backgroundColor),
		ui.terminal,
	);

	let mounted = true;
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
