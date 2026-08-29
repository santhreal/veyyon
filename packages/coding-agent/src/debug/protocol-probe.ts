import { type Component, Container, Image, type ImageBudget, Spacer, TERMINAL, Text } from "@veyyon/tui";
import { COMPOSER_INSET_COLS } from "../modes/components/composer-chrome";
import { theme } from "../modes/theme/theme";
import type { SampleImage } from "./protocol-probe-helpers";
import { buildLargeTextLines, imageProtocolLabel, notifyProtocolLabel, truecolorBar } from "./protocol-probe-helpers";

export { buildSampleImage, encodeRgbPng } from "./protocol-probe-helpers";
export { buildLargeTextLines };

class RawLines implements Component {
	#lines: readonly string[];
	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return this.#lines.slice();
	}
}

export interface ProtocolProbeOptions {
	image: SampleImage;
	imageBudget: ImageBudget;
	notificationSuppressed: boolean;
}

export class ProtocolProbeComponent extends Container {
	constructor(options: ProtocolProbeOptions) {
		super();
		const hyperlinksOn = TERMINAL.hyperlinks;
		const sizingOn = TERMINAL.textSizing;
		const yesNo = (on: boolean) => (on ? theme.fg("success", "supported") : theme.fg("muted", "unsupported"));

		this.addChild(new Text(theme.bold(theme.fg("accent", "Terminal Protocol Test")), COMPOSER_INSET_COLS, 0));
		this.addChild(new Spacer(1));

		const styling = [
			theme.fg("muted", "Styling (SGR)"),
			`  ${theme.bold("bold")}  ${theme.italic("italic")}  ${theme.underline("underline")}  ${theme.strikethrough("strike")}  ${theme.inverse(" inverse ")}  ${theme.fg("dim", "dim")}`,
			`  ${theme.fg("accent", "accent")}  ${theme.fg("success", "success")}  ${theme.fg("warning", "warning")}  ${theme.fg("error", "error")}`,
			`  truecolor: ${truecolorBar(32)} (${theme.fg("muted", `24-bit ${TERMINAL.trueColor ? "on" : "off"}`)})`,
		].join("\n");
		this.addChild(new Text(styling, COMPOSER_INSET_COLS, 0));
		this.addChild(new Spacer(1));

		this.addChild(
			new Text(
				[
					`${theme.fg("muted", "Hyperlinks (OSC 8)")} — ${yesNo(hyperlinksOn)}`,
					`  \x1b]8;;https://github.com/santhreal/veyyon\x07Veyyon repo\x1b]8;;\x07`,
				].join("\n"),
				COMPOSER_INSET_COLS,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.addChild(
			new Text(`${theme.fg("muted", "Text sizing (OSC 66)")} — ${yesNo(sizingOn)}`, COMPOSER_INSET_COLS, 0),
		);
		if (sizingOn) {
			this.addChild(new RawLines(buildLargeTextLines()));
		} else {
			this.addChild(
				new Text(
					theme.fg("dim", "  (enable via the tui.textSizing setting on a Kitty terminal)"),
					COMPOSER_INSET_COLS,
					0,
				),
			);
		}
		this.addChild(new Spacer(1));

		this.addChild(
			new Text(
				`${theme.fg("muted", "Graphics")} — ${theme.fg("dim", imageProtocolLabel())}`,
				COMPOSER_INSET_COLS,
				0,
			),
		);
		this.addChild(
			new Image(
				options.image.base64,
				options.image.mimeType,
				{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
				{ maxWidthCells: 20, maxHeightCells: 16, budget: options.imageBudget },
				options.image.dimensions,
			),
		);
		this.addChild(new Spacer(1));

		const notifyStatus = options.notificationSuppressed
			? theme.fg("warning", "suppressed (VEYYON_NOTIFICATIONS)")
			: theme.fg("success", "sent — check your desktop / titlebar");
		this.addChild(
			new Text(
				`${theme.fg("muted", "Notification")} (${theme.fg("dim", notifyProtocolLabel())}) — ${notifyStatus}`,
				COMPOSER_INSET_COLS,
				0,
			),
		);
	}
}
