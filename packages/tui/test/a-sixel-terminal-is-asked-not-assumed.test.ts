/**
 * WHY: sixel images never rendered on Linux or macOS. `KNOWN_TERMINALS` names
 * an image protocol for five terminals — kitty, ghostty, wezterm, iterm2, warp
 * — and every one of them is Kitty or iTerm2; no entry carries
 * `ImageProtocol.Sixel`. Anything else resolves to `base`/`trueColor`, whose
 * protocol is null, and a null protocol makes image rendering return nothing
 * and print no reason. The runtime DA probe that would have settled it existed
 * and worked, but `#querySixelSupport` returned early unless the platform was
 * win32 AND `WT_SESSION` was set, so on every POSIX terminal it never ran.
 *
 * The class this closes is a capability answered by a hardcoded list where the
 * terminal itself can be asked. `planSixelProbe` is the single decision point
 * the TUI now calls, so the suite pins the decision for each platform and
 * environment rather than the one terminal from the report.
 *
 * What it does not catch: whether a terminal answering DA with attribute 4
 * actually paints the sixel it advertises, and the parsing of the reply, which
 * `#handleSixelProbeInput` owns.
 */

import { describe, expect, test } from "bun:test";
import { ImageProtocol, planSixelProbe } from "@veyyon/tui";

const NO_ENV: NodeJS.ProcessEnv = {};
const WT: NodeJS.ProcessEnv = { WT_SESSION: "1" };

/** Every platform the product runs on, so a new branch cannot skip the sweep. */
const POSIX_PLATFORMS: NodeJS.Platform[] = ["linux", "darwin", "freebsd", "openbsd"];

describe("a sixel terminal is asked, not assumed", () => {
	for (const platform of POSIX_PLATFORMS) {
		test(`${platform} with no statically known protocol is probed with DA`, () => {
			const plan = planSixelProbe(null, true, NO_ENV, platform);
			expect(plan).toEqual({ xtsmgraphics: false });
		});
	}

	test("Windows Terminal is probed with DA and the xterm graphics query", () => {
		expect(planSixelProbe(null, true, WT, "win32")).toEqual({ xtsmgraphics: true });
	});

	test("a win32 console that is not Windows Terminal is not probed", () => {
		// It answers neither query, so asking only costs the timeout.
		expect(planSixelProbe(null, true, NO_ENV, "win32")).toBeNull();
	});

	test("a terminal whose protocol static detection already resolved is not probed", () => {
		// kitty, ghostty, wezterm, warp
		expect(planSixelProbe(ImageProtocol.Kitty, true, NO_ENV, "linux")).toBeNull();
		// iterm2
		expect(planSixelProbe(ImageProtocol.Iterm2, true, NO_ENV, "darwin")).toBeNull();
		// VEYYON_FORCE_IMAGE_PROTOCOL=sixel, already applied to TERMINAL
		expect(planSixelProbe(ImageProtocol.Sixel, true, NO_ENV, "linux")).toBeNull();
	});

	test("a non-TTY is never probed, on any platform", () => {
		// No reply can arrive, so the query would be written into a pipe and the
		// probe would only ever time out.
		for (const platform of [...POSIX_PLATFORMS, "win32" as NodeJS.Platform]) {
			expect(planSixelProbe(null, false, WT, platform)).toBeNull();
		}
	});

	test("the xterm graphics query is never sent to a POSIX terminal", () => {
		// XTSMGRAPHICS is an xterm extension; DA is the universal question.
		// WT_SESSION set on a POSIX host (an odd but reachable env) must not
		// promote the query.
		for (const platform of POSIX_PLATFORMS) {
			expect(planSixelProbe(null, true, WT, platform)?.xtsmgraphics).toBe(false);
		}
	});
});
