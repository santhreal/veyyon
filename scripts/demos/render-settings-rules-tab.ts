/**
 * Print the real `/settings` surface parked on a named sidebar section.
 *
 * `--tab` goes through the component's own `openTab`, so the frame is the one a
 * user reaches by clicking that sidebar entry. Use it to prove a section exists
 * AND that its contents are what the sidebar entry promises — a section that
 * renders empty is the failure mode worth catching.
 *
 * `--open <query>` then types that query and presses Enter, which is how a user
 * reaches a row's editor. The rule list is a submenu rather than a row value,
 * and its grouping is the thing worth looking at, so proving it needs the real
 * drill-in rather than a screenshot of the row that leads to it.
 *
 * `--section <name>` drills the SECOND level, filtering the section index the
 * same way and pressing Enter again. The rule list is two screens now — an index
 * of sections and one section's rules — and a proof of either one alone says
 * nothing about the other, so both are reachable from one script.
 *
 * `--agent-dir <path>` reads that directory's real `config.yml` instead of the
 * default in-memory settings, which is the only way to capture an off-vs-on
 * differential for a rule setting: `ttsr.experimentalRules` is a persisted value,
 * and an in-memory capture can only ever show its default.
 *
 * Usage:
 *
 *     bun scripts/demos/render-settings-rules-tab.ts --tab rules --width 92 --height 26
 *     bun scripts/demos/render-settings-rules-tab.ts --tab rules --open Rules --height 34
 *     bun scripts/demos/render-settings-rules-tab.ts --tab rules --open Rules --section Workflow
 *     bun scripts/demos/render-settings-rules-tab.ts --tab rules --open Rules --agent-dir /tmp/seeded
 */
import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { SETTING_TABS } from "../../packages/coding-agent/src/config/settings-schema";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const height = Number(flag("height", "26"));
const tab = flag("tab", "rules");

if (!SETTING_TABS.includes(tab as (typeof SETTING_TABS)[number])) {
	throw new Error(`unknown tab ${JSON.stringify(tab)}; one of: ${SETTING_TABS.join(", ")}`);
}

Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
// Settings before the theme either way: `Settings.init` applies the CONFIGURED
// theme, so initialising the theme first has it silently replaced.
const agentDir = flag("agent-dir", "");
if (agentDir.length > 0) {
	await Settings.init({ agentDir });
	await initRender(themeName);
} else {
	await initRender(themeName, { settings: true });
}

const selector = new SettingsSelectorComponent(
	{
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: [themeName, "light"],
		availablePersonalities: ["default"],
		providers: ["anthropic"],
		cwd: process.cwd(),
	},
	{ onChange: () => {}, onCancel: () => {} },
);

/** Yield until `ready()` holds, or give up loudly rather than print a half-loaded frame. */
async function settle(ready: () => boolean, attempts = 200): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (ready()) return;
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
	}
	throw new Error("the rule list never finished loading");
}

selector.openTab(tab as (typeof SETTING_TABS)[number]);

const open = flag("open", "");
if (open.length > 0) {
	for (const character of open) selector.handleInput(character);
	selector.handleInput("\r");
	// The rule list discovers its rows off the filesystem, so a frame taken
	// immediately reads "Reading rules…" and proves nothing about the grouping.
	// Wait for the real load rather than a fixed sleep, which would race on a
	// cold cache and pass locally while producing an empty proof in CI.
	await settle(() => !selector.render(width).join("\n").includes("Reading rules"));
}

const section = flag("section", "");
if (section.length > 0) {
	if (open.length === 0) throw new Error("--section needs --open to reach the rule list first");
	// Arrow keys, not a typed query: `SelectList` accepts a filter only while the
	// list overflows its visible rows, and the section index never does. Walking
	// to the row and reading the cursor back is also what a user does, so a proof
	// taken this way cannot show a section that is unreachable by hand.
	//
	// The card draws the sidebar and the content pane on one line between box
	// rules, and the sidebar has a cursor of its own, so the content pane is
	// taken by column before the cursor is read. Matching the cursor anywhere on
	// the line would accept the sidebar's.
	const CURSOR = "\u203a";
	for (let step = 0; ; step++) {
		const landed = selector.render(width).some(line => {
			const columns = stripVTControlCharacters(line).split("\u2502");
			const pane = columns.at(-2) ?? "";
			return columns.length >= 3 && pane.trimStart().startsWith(CURSOR) && pane.includes(section);
		});
		if (landed) break;
		if (step >= 40) throw new Error(`no section row matching ${JSON.stringify(section)}`);
		selector.handleInput("\x1b[B");
	}
	selector.handleInput("\r");
	// Landing back on the index means Enter did not open anything, which is a
	// silent wrong proof rather than an error unless it is caught here.
	if (selector.render(width).join("\n").includes("Rules by section")) {
		throw new Error(`Enter on ${JSON.stringify(section)} did not open a section`);
	}
}

process.stdout.write(`${selector.render(width).join("\n")}\n`);
