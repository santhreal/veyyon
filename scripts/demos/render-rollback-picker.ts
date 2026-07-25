/**
 * Print the version picker as ANSI, deterministically.
 *
 * The picker cannot be captured by driving `veyyon rollback` for a proof shot:
 * that reads the live release list over the network, so the frame would depend
 * on what is published on the day, and it renders an error rather than a picker
 * whenever the machine is offline. Neither makes a repeatable image.
 *
 * So this renders the SHIPPED component against fixed rows. It is the real
 * `RollbackPickerComponent` with the real theme, not a mock of it: the point of
 * a visual proof is that the pixels come from the code that ships.
 *
 * Usage, from a VHS tape or by hand:
 *
 *     bun scripts/demos/render-rollback-picker.ts [--theme titanium|light] [--width 100] [--filtered]
 *
 * `--filtered` renders the searched state, which is the second frame worth
 * proving: the markers have to stay readable once the list is short.
 */
import { buildRollbackRows } from "../../packages/coding-agent/src/cli/rollback-cli";
import { RollbackPickerComponent } from "../../packages/coding-agent/src/modes/components/rollback-picker";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { flag, hasFlag, renderWidth } from "./render-args";

/** A release history with one of every marker, so no row state goes unproven. */
const RELEASES = [
	{ tag: "v1.6.0", version: "1.6.0", publishedAt: "2026-07-20T00:00:00Z" },
	{ tag: "v1.5.2", version: "1.5.2", publishedAt: "2026-07-11T00:00:00Z" },
	{ tag: "v1.5.1", version: "1.5.1", publishedAt: "2026-07-02T00:00:00Z" },
	{ tag: "v1.5.0", version: "1.5.0", publishedAt: "2026-06-24T00:00:00Z" },
	{ tag: "v1.4.0", version: "1.4.0", publishedAt: "2026-06-10T00:00:00Z" },
	{ tag: "v1.3.1", version: "1.3.1", publishedAt: "2026-05-29T00:00:00Z" },
	{ tag: "v1.3.0", version: "1.3.0", publishedAt: "2026-05-14T00:00:00Z" },
];

const CURRENT = "1.5.1";
const MOVES = [{ from: "1.4.0", to: "1.5.0", at: "2026-06-25T00:00:00Z" }];

const themeName = flag("theme", "titanium");
const width = renderWidth();
const filtered = hasFlag("filtered");

// Both slots get the same theme so the render does not depend on the capturing
// terminal's background luminance, which is what the tape is varying.
await initTheme(false, "unicode", false, themeName, themeName);

const rows = buildRollbackRows(RELEASES, CURRENT, MOVES);
const picker = new RollbackPickerComponent(rows, {
	onSelect: () => {},
	onCancel: () => {},
	openUrl: () => {},
});
if (filtered) picker.getSelectList().setFilter("1.5");

process.stdout.write(`${picker.render(width).join("\n")}\n`);
