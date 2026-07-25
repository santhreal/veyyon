/**
 * Print the post-update notice, before and after, as ANSI.
 *
 * The change moved the notice from its own transcript block above the welcome
 * card into the card's tip slot. Proving that needs both renders side by side,
 * and neither can be captured by launching veyyon: the notice fires off a
 * marker file comparison against the version on disk, so a live capture would
 * depend on whether this machine happens to have just been updated.
 *
 * `--variant before` reproduces the deleted transcript block exactly as
 * `ui-helpers.ts` built it, so the pair compares the real old render against
 * the real new one rather than against a description of it.
 *
 * Usage:
 *
 *     bun scripts/demos/render-update-notice.ts --variant before|after [--theme titanium]
 */
import { APP_NAME } from "@veyyon/utils";
import {
	setLaunchTip,
	updateInstalledTip,
	WelcomeComponent,
} from "../../packages/coding-agent/src/modes/components/welcome";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/theme/theme";
import { flag, renderWidth } from "./render-args";

const variant = flag("variant", "after");
const themeName = flag("theme", "titanium");
const width = renderWidth();
const VERSION_SHOWN = "1.5.2";

await initTheme(false, "unicode", false, themeName, themeName);

if (variant === "before") {
	// The transcript block this change deleted, rebuilt line for line from the
	// removed `showUpdateInstalledNotification`, above the welcome card it sat on
	// top of.
	const notice =
		theme.fg("accent", `Updated to ${APP_NAME} ${VERSION_SHOWN}`) +
		theme.fg("dim", " · run ") +
		theme.fg("accent", "/changelog") +
		theme.fg("dim", " for release notes");
	process.stdout.write(`\n ${notice}\n\n`);
} else {
	setLaunchTip(updateInstalledTip(VERSION_SHOWN));
}

const welcome = new WelcomeComponent(VERSION_SHOWN, "claude-sonnet-5", "anthropic");
process.stdout.write(`${welcome.render(width).join("\n")}\n`);
