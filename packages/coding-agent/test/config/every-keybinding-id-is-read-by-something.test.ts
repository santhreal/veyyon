/**
 * A keybinding id that nothing reads is a promise to the user that nothing keeps.
 *
 * WHY THIS SUITE EXISTS. `KEYBINDINGS` is not an internal table. Every id in it is
 * shown to the user by `/hotkeys` and written into the generated `keybindings.yml`
 * as something they may remap, with a default key beside it. So an id nothing reads
 * is not dead code sitting quietly out of the way: it is a documented shortcut that
 * does nothing when pressed.
 *
 * Eight of them were exactly that. `app.session.rename`, `app.session.togglePath`,
 * `app.session.toggleSort` and `app.session.deleteNoninvasive` named actions the
 * session selector does not have at all. `app.tree.foldOrUp` and
 * `app.tree.unfoldOrDown` named a tree it does not implement. And
 * `app.session.delete` named an action it DOES have, except the selector matches the
 * literal `delete` and `backspace` keys rather than reading a binding, so remapping
 * it changed nothing.
 *
 * The eighth, `tui.input.copy`, came from the other package. The editor returns
 * early on `ctrl+c` so the app-level interrupt survives, and its own comment says
 * why: it "has no copy implementation". So the binding named a key that does not
 * copy, and rebinding it to some other key produced nothing at all.
 *
 * The worst of them was a lie rather than a silence. `app.session.toggleSort`
 * claimed `ctrl+s`, and `ctrl+s` is `app.session.observe`, which opens the Agent
 * Control Center. A user reading `/hotkeys` was told `ctrl+s` sorts their session
 * list, and pressing it opened a different screen.
 *
 * `toKeybindingsConfig` keeps unknown keys from a user's file without complaining,
 * so removing an id cannot break anybody's `keybindings.yml`: an entry naming a
 * removed id is inert, which is what it already was.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { KEYBINDINGS } from "@veyyon/coding-agent/config/keybindings";

const CODING_AGENT_SRC = path.resolve(import.meta.dir, "../../src");
const TUI_SRC = path.resolve(import.meta.dir, "../../../tui/src");

/**
 * Both roots are scanned, because the table is assembled from two packages.
 *
 * `KEYBINDINGS` spreads `TUI_KEYBINDINGS` from `@veyyon/tui`, and the components
 * that read the `tui.*` ids live in that package. Scanning only `coding-agent`
 * would report all twenty-four of them as unread, which is a wall of false
 * findings and the fastest way to get a gate switched off.
 */
const ROOTS = [CODING_AGENT_SRC, TUI_SRC];

/** The two modules that DECLARE the bindings, which naturally name all of them. */
const DECLARING_MODULES = new Set([
	path.join(CODING_AGENT_SRC, "config", "keybindings.ts"),
	path.join(TUI_SRC, "keybindings.ts"),
]);

/**
 * Ids read through a variable rather than a literal, with the reader that does it.
 *
 * `hotkeys-markdown.ts` builds the `/hotkeys` table by iterating the whole map, so
 * it reads every id without naming any. That is a legitimate reader and it is also
 * the reason the rule cannot simply be "is this string somewhere else": a table
 * printer would make every id look consumed. Nothing is on this list today, and an
 * entry added to it needs the reader named and a reason.
 */
const READ_DYNAMICALLY: Readonly<Record<string, string>> = {};

/** Every `.ts` under a root that is not a test and not one of the declaring modules. */
function consumerSources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__" && entry.name !== "vendor") consumerSources(full, found);
			continue;
		}
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
		if (DECLARING_MODULES.has(full)) continue;
		found.push(full);
	}
	return found;
}

const CONSUMER_TEXT = ROOTS.flatMap(root => consumerSources(root))
	.map(file => fs.readFileSync(file, "utf8"))
	.join("\n");

const IDS = Object.keys(KEYBINDINGS).sort();

describe("every keybinding id is read by something", () => {
	/**
	 * Both sides are real. An empty id list or an empty corpus would satisfy the
	 * rule below while checking nothing, which is the failure mode of every rule
	 * built on a source scan.
	 */
	it("reads a substantial binding table and a substantial corpus", () => {
		expect(IDS.length).toBeGreaterThan(50);
		expect(CONSUMER_TEXT.length).toBeGreaterThan(500_000);
		expect(IDS).toContain("app.session.observe");
	});

	/**
	 * The rule. A failure means an id is advertised to the user and nothing acts on
	 * it: either wire the surface that should read it, or delete the id so
	 * `/hotkeys` stops naming a shortcut that does nothing.
	 */
	it("has no id that only its own declaration mentions", () => {
		const unread = IDS.filter(id => !(id in READ_DYNAMICALLY) && !CONSUMER_TEXT.includes(id));

		expect(
			unread,
			"these ids are shown by /hotkeys and written into keybindings.yml, and nothing reads them. Wire the surface, or remove the id",
		).toEqual([]);
	});

	/**
	 * The eight that were removed stay removed, by name.
	 *
	 * The rule above would accept any of them back the moment somebody added a
	 * reference, even a reference that does not act on the key. These say the
	 * feature has to exist first.
	 */
	it.each([
		["app.session.rename", "the session selector has no rename action"],
		["app.session.togglePath", "the session selector has no path toggle"],
		["app.session.toggleSort", "the session selector has no sort toggle, and ctrl+s is app.session.observe"],
		["app.session.deleteNoninvasive", "there is no second delete path"],
		["app.session.delete", "the selector matches the literal delete/backspace keys, not a binding"],
		["app.tree.foldOrUp", "there is no tree view with folding"],
		["app.tree.unfoldOrDown", "there is no tree view with folding"],
		["tui.input.copy", "the editor has no copy implementation and returns early on ctrl+c"],
	])("does not declare %s again", (id, why) => {
		expect(IDS, `${id} was removed because ${why}. Build the feature before advertising the key`).not.toContain(id);
	});
});

describe("no two bindings claim the same default key in the same area", () => {
	/**
	 * `app.session.toggleSort` and `app.session.observe` both defaulted to `ctrl+s`,
	 * and only one of them could win. A collision inside one `app.<area>.*` group is
	 * the case worth failing on: those bindings are live on the same screen, so the
	 * loser is a shortcut the user is told about and cannot use.
	 *
	 * Across areas a shared key is normal and intended: `ctrl+c` means one thing in
	 * the composer and another in a picker, because only one of those is listening.
	 */
	it("has no two ids in one area with the same default key", () => {
		const byAreaAndKey = new Map<string, string[]>();
		for (const [id, binding] of Object.entries(KEYBINDINGS as Record<string, { defaultKeys: string | string[] }>)) {
			const area = id.split(".").slice(0, 2).join(".");
			const keys = Array.isArray(binding.defaultKeys) ? binding.defaultKeys : [binding.defaultKeys];
			for (const key of keys) {
				if (!key) continue;
				const slot = `${area} ${key}`;
				byAreaAndKey.set(slot, [...(byAreaAndKey.get(slot) ?? []), id]);
			}
		}

		const collisions = [...byAreaAndKey.entries()]
			.filter(([, ids]) => ids.length > 1)
			.map(([slot, ids]) => `${slot}: ${ids.join(" and ")}`)
			.sort();

		expect(collisions).toEqual([]);
	});
});
