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
 * instead of building its own: the same TUI, and the same card, whose model
 * line and recent session arrive through `WelcomeComponent.setModel` and
 * `setRecentSessions` once the session resolves them.
 *
 * One TUI per process is a hard constraint -- `terminal.start` puts stdin in
 * raw mode and installs the reader, so a second instance reads the same fd --
 * and the tty handover moves here with it: the queue is flushed, a swallow gate
 * is installed, and that gate releases only once the composer is mounted and a
 * keystroke has somewhere to land. The mode reads the frame through
 * {@link takeFirstFrame} rather than a constructor argument, for the same
 * reason the terminal layer keeps its active instance at module level: there is
 * one screen, and whoever owns it owns it for the process.
 */

import {
	matchesKey,
	ProcessTerminal,
	planPaintGround,
	Spacer,
	setTerminalTextSizing,
	setTuiTight,
	TERMINAL,
	TUI,
} from "@veyyon/tui";
import { logger } from "@veyyon/utils";
import { settings } from "../config/settings-instance";
import { StaticComposerFrame } from "./components/composer-chrome";
import { WelcomeComponent } from "./components/welcome";
import { HomeAnchorLayout } from "./controllers/home-anchor-layout";
import { applyGroundPaint, setDetectedTerminalGround } from "./theme/ground-tints";
import { theme } from "./theme/theme";
import { flushPendingTtyInput } from "./tty-input-flush";

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
	/** Drop the placeholder rows, leaving an empty root for the mode's own tree. Idempotent. */
	release(): void;
	/**
	 * Let input through to the composer, which is mounted by the time this runs,
	 * and return the text typed at the card while the gate held it. The caller
	 * places that text in the composer. Idempotent: a second call returns "".
	 */
	releaseInput(): string;
}

/**
 * How much of what is typed at the launch card carries into the composer. A
 * held key repeats, and no startup draft needs more than this; past the cap
 * the remainder is dropped rather than grown without bound.
 */
const STARTUP_TYPEAHEAD_LIMIT = 4096;

/**
 * True when a chunk is ordinary typed text rather than a control sequence.
 *
 * The gate receives everything the terminal sends, and during startup that
 * includes the terminal's own answers to the probes the screen just issued
 * (OSC 11 for the ground, the DA query, the sixel query), as well as arrow
 * keys, mouse reports and bracketed-paste wrappers. Each of those carries ESC
 * or another C0 byte, so accepting only printable characters keeps a probe
 * reply out of the draft without enumerating the sequences. It also excludes
 * the carriage return the gate exists to stop, so a queued newline still
 * cannot submit a turn.
 *
 * An empty chunk answers true and appends nothing, which is why there is no
 * guard for it: the guard could not be observed failing.
 */
function isTypedText(data: string): boolean {
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
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
	const composerFrame = new StaticComposerFrame();
	const children = [
		layout.topFill,
		new Spacer(1),
		hero,
		new Spacer(1),
		layout.bottomFill,
		// The composer at rest, painted NOW. Centring is a share of the slack
		// below the card (HomeAnchorLayout), so the zone's height has to be on
		// screen before the zone exists: this paints the resting zone's exact
		// row count with its real chrome, and the mounted zone swaps text into
		// those rows rather than arriving under them.
		composerFrame,
	];
	for (const child of children) ui.addChild(child);
	// No frame has been composed, so this measures the children directly.
	layout.sync(true);

	// The tty handover, which `InteractiveMode.init` used to own: a relaunch
	// (`/profile <name>` respawns the CLI) leaves whatever arrived while no one
	// was reading fd 0 queued in the kernel, and starting the terminal delivers
	// that backlog as this session's first input -- a queued carriage return
	// submits a turn nobody typed. Drop the queue outright, then hold what is
	// typed afterwards and swallow the rest, except ctrl+c (which must stay
	// live to abort a launch), until the composer is mounted.
	const flushed = flushPendingTtyInput();
	// What arrives from here on is the operator's. The queue that predates this
	// session went out with the flush above, and the card already carries a
	// composer frame, so a printable chunk arriving now was typed at something
	// that looks ready to receive it. Hold it and hand it to the real composer
	// at mount instead of discarding it: session startup runs for over a
	// second, and every keystroke inside that window was being dropped. Control
	// input is still swallowed, and ctrl+c still passes through so a launch can
	// be aborted. Without the flush the pre-launch backlog is still queued and
	// cannot be told apart from typing, so that degrade discards as before.
	let typeahead = "";
	let inputGate: (() => void) | undefined = ui.addInputListener(data => {
		if (matchesKey(data, "ctrl+c")) return undefined;
		if (flushed && isTypedText(data)) {
			typeahead = (typeahead + data).slice(0, STARTUP_TYPEAHEAD_LIMIT);
			// Echo it. Holding the text is only half of the handover: the card
			// paints a composer for the whole of startup, and one that shows
			// nothing back reads as a composer that is not listening. Forced,
			// because the ordinary path waits for the next throttle frame and a
			// keystroke that appears a frame late is the lag this exists to
			// remove; the card is a handful of rows, so the repaint is cheap.
			composerFrame.setDraft(typeahead);
			ui.requestRender(true);
		}
		return { consume: true };
	});
	if (!flushed) {
		logger.debug("No tty input flush available at startup; discarding buffered input until mount completes");
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
		release(): void {
			if (!mounted) return;
			mounted = false;
			for (const child of children) ui.removeChild(child);
		},
		releaseInput(): string {
			inputGate?.();
			inputGate = undefined;
			const typed = typeahead;
			typeahead = "";
			return typed;
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
