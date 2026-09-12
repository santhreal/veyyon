/**
 * Print the pinned error banner in the place it appears: directly above the
 * composer, under the last thing the transcript said.
 *
 * The banner is the loudest thing on the screen by design, so the question the
 * image answers is whether it is loud in the message or loud in its chrome. The
 * composer hairline and the prompt gutter are rendered under it, from the real
 * composer chrome, so the banner's left edge can be compared against the edge
 * the prompt sits on.
 *
 * Run:
 *     bun scripts/demos/render-error-banner.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/banner --width 100 --scale 2
 */
import {
	COMPOSER_INSET_COLS,
	ComposerHairline,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "../../packages/coding-agent/src/modes/terminal/components/composer/composer-chrome";
import { ErrorBannerComponent } from "../../packages/coding-agent/src/modes/terminal/components/transcript/error-banner";
import { renderDemo } from "./render-args";

await renderDemo(({ width }) => {
	const accents = resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE);
	return [
		`${" ".repeat(COMPOSER_INSET_COLS)}I could not finish that turn.`,
		...new ErrorBannerComponent("Output blocked by content filtering policy").render(width),
		...new ComposerHairline().render(width),
		"",
		`${accents.promptGutter}`,
		"",
	];
});
