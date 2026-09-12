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
} from "../../packages/coding-agent/src/modes/terminal/components/dialogs/welcome";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

const VERSION_SHOWN = "1.5.2";

await renderDemo(({ width, flag }) => {
	const lines: string[] = [];
	if (flag("variant", "after") === "before") {
		// The transcript block this change deleted, rebuilt line for line from the
		// removed `showUpdateInstalledNotification`, above the welcome card it sat on
		// top of.
		const notice =
			theme.fg("accent", `Updated to ${APP_NAME} ${VERSION_SHOWN}`) +
			theme.fg("dim", " · run ") +
			theme.fg("accent", "/changelog") +
			theme.fg("dim", " for release notes");
		lines.push("", ` ${notice}`, "");
	} else {
		setLaunchTip(updateInstalledTip(VERSION_SHOWN));
	}
	const welcome = new WelcomeComponent(VERSION_SHOWN, "claude-sonnet-5", "anthropic");
	lines.push(...welcome.render(width));
	return lines;
});
