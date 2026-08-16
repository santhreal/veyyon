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
	resolveComposerAccents,
} from "../../packages/coding-agent/src/modes/components/composer-chrome";
import { ErrorBannerComponent } from "../../packages/coding-agent/src/modes/components/error-banner";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { flag, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initTheme(false, "unicode", false, themeName, themeName);

const accents = resolveComposerAccents({
	bypass: false,
	bashMode: false,
	pythonMode: false,
	planMode: false,
	focusedSubagent: false,
	sessionAccentAnsi: undefined,
	thinkingLevel: "off",
});

const lines: string[] = [];
lines.push(`${" ".repeat(COMPOSER_INSET_COLS)}I could not finish that turn.`);

const banner = new ErrorBannerComponent("Output blocked by content filtering policy");
lines.push(...banner.render(width));

lines.push(...new ComposerHairline().render(width));
lines.push("");
lines.push(`${accents.promptGutter}`);
lines.push("");

process.stdout.write(`${lines.join("\n")}\n`);
