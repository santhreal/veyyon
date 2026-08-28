/** The launch card, painted before the session exists. `InteractiveMode` builds the TUI in its constructor and mounts the tree in */

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
	/** The card on screen. The mode remounts this instance rather than building a second one, so the sun, the tip and the row count do not change under */
	readonly hero: WelcomeComponent;
	/** Drop the placeholder rows, leaving an empty root for the mode's own tree. Idempotent. */
	release(): void;
	/** Let input through to the composer, which is mounted by the time this runs, and return the text typed at the card while the gate held it. The caller */
	releaseInput(): string;
}

/** How much of what is typed at the launch card carries into the composer. A held key repeats, and no startup draft needs more than this; past the cap */
const STARTUP_TYPEAHEAD_LIMIT = 4096;

/** True when a chunk is ordinary typed text rather than a control sequence. The gate receives everything the terminal sends, and during startup that */
function isTypedText(data: string): boolean {
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code === 0x7f || code === 0x08) continue;
		if (code < 0x20) return false;
	}
	return true;
}

/** Apply one accepted chunk to the held draft: text appends, a backspace takes one character off. */
function applyTypedEdit(draft: string, data: string): string {
	let next = draft;
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code === 0x7f || code === 0x08) next = next.slice(0, -1);
		else next += data[i];
	}
	return next;
}

let painted: FirstFrame | undefined;

/** Build the screen, paint the launch card on it, and start reading the terminal. The frame is held for {@link takeFirstFrame}; the caller keeps */
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
		// The composer at rest, painted NOW. Centring is a share of the slack below the card (HomeAnchorLayout), so the zone's height has to be on
		composerFrame,
	];
	for (const child of children) ui.addChild(child);
	// No frame has been composed, so this measures the children directly.
	layout.sync(true);

	// The tty handover, which `InteractiveMode.init` used to own. Two different things can be sitting in the kernel's input queue by now, and the bytes do
	const relaunched = consumeRelaunchMarker();
	const flushed = relaunched ? flushPendingTtyInput() : false;
	// Hold what is typed and swallow the rest, except ctrl+c, which stays live
	// so a launch can be aborted, until the composer is mounted.
	let typeahead = "";
	let inputGate: (() => void) | undefined = ui.addInputListener(data => {
		if (matchesKey(data, "ctrl+c")) return undefined;
		// A relaunch that could not flush (Windows has no termios) cannot tell
		// the stale queue from typing, so it degrades to discarding both.
		if ((flushed || !relaunched) && isTypedText(data)) {
			typeahead = applyTypedEdit(typeahead, data).slice(0, STARTUP_TYPEAHEAD_LIMIT);
			// Echo it. Holding the text is only half of the handover: the card paints a composer for the whole of startup, and one that shows
			composerFrame.setDraft(typeahead);
			ui.requestRender(true);
		}
		return { consume: true };
	});
	if (relaunched && !flushed) {
		logger.debug("No tty input flush available at startup; discarding buffered input until mount completes");
	}
	// The first paint always clears the viewport (ED 2) so the card never appends over the previous run's frame. Erasing the terminal's saved
	ui.start({ clearScrollback: settings.get("startup.clearScrollback") });
	// The theme ground goes on with the card, not 300ms after it. `auto` needs the terminal's OSC 11 answer, which has not arrived this early, so it
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

/** The painted frame, once. A second interactive mode in the same process (a test harness, a relaunch that got as far as constructing one) builds its own */
export function takeFirstFrame(): FirstFrame | undefined {
	const frame = painted;
	painted = undefined;
	return frame;
}
