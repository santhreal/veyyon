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

export interface FirstFrameDecisionOptions {
	readonly isInteractive: boolean;
	readonly protocolMode: boolean;
	readonly quiet: boolean;
	readonly splash: boolean;
	readonly setupWizard: boolean;
	readonly stdinIsTTY: boolean | undefined;
	readonly stdoutIsTTY: boolean | undefined;
	readonly resuming?: boolean;
}

export function shouldPaintFirstFrame(options: FirstFrameDecisionOptions): boolean {
	if (!options.isInteractive || options.protocolMode) return false;
	if (options.quiet || options.splash || options.setupWizard || options.resuming) return false;
	return options.stdinIsTTY === true && options.stdoutIsTTY === true;
}

export interface FirstFrame {
	readonly ui: TUI;
	readonly hero: WelcomeComponent;
	release(): void;
	releaseInput(): string;
}

const STARTUP_TYPEAHEAD_LIMIT = 4096;

function isTypedText(data: string): boolean {
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code === 0x7f || code === 0x08) continue;
		if (code < 0x20) return false;
	}
	return true;
}

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
	const children = [layout.topFill, new Spacer(1), hero, new Spacer(1), layout.bottomFill, composerFrame];
	for (const child of children) ui.addChild(child);
	layout.sync(true);

	const relaunched = consumeRelaunchMarker();
	const flushed = relaunched ? flushPendingTtyInput() : false;
	let typeahead = "";
	let inputGate: (() => void) | undefined = ui.addInputListener(data => {
		if (matchesKey(data, "ctrl+c")) return undefined;
		if ((flushed || !relaunched) && isTypedText(data)) {
			typeahead = applyTypedEdit(typeahead, data).slice(0, STARTUP_TYPEAHEAD_LIMIT);
			composerFrame.setDraft(typeahead);
			ui.requestRender(true);
		}
		return { consume: true };
	});
	if (relaunched && !flushed) {
		logger.debug("No tty input flush available at startup; discarding buffered input until mount completes");
	}
	ui.start({ clearScrollback: settings.get("startup.clearScrollback") });
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

export function takeFirstFrame(): FirstFrame | undefined {
	const frame = painted;
	painted = undefined;
	return frame;
}
