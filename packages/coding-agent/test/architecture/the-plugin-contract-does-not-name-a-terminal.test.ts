/**
 * The published plugin contract must not make every plugin a terminal plugin.
 *
 * `packages/coding-agent/package.json` exports `./extensibility/*`, so the types
 * under `src/extensibility/` are the surface a third-party plugin is written
 * against. Every one of those files that imports `@veyyon/tui` puts a terminal
 * type into that surface, and a host that is not a terminal — the HTML export,
 * the collab web client, the stats dashboard, any GUI — cannot satisfy it.
 *
 * The distinction this locks is between what a plugin RETURNS and what a plugin
 * RECEIVES:
 *
 * - A renderer's return is host-agnostic. The core cannot name the node type,
 *   because there is more than one host and they share none, so it names
 *   `HostView` instead. A terminal plugin returning a `Component` still
 *   satisfies that, since return position is covariant.
 * - A screen-takeover API's parameters are not. `ui.custom(factory)` hands the
 *   plugin a live `TUI` and expects a component back; `setEditorComponent` hands
 *   it the editor. Parameter position is contravariant, so those cannot be
 *   widened without breaking every plugin that uses them, and they are honestly
 *   terminal-only: a GUI has no `TUI` to hand over. They stay, named here, as a
 *   capability rather than a fact of the contract.
 *
 * WHAT THIS DOES NOT CATCH. It reads imports, not meaning. A contract file could
 * describe a terminal in prose, or take a structurally terminal-shaped object it
 * declares itself, and this stays green. It also says nothing about the 71 files
 * outside `src/extensibility/` that import `@veyyon/tui`; those are veyyon's own
 * code, not the published contract, and they are a separate problem.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const EXTENSIBILITY_DIR = path.join(import.meta.dir, "..", "..", "src", "extensibility");

/**
 * The files allowed to name the terminal, and why each one is not a defect.
 *
 * A reason, not a count: this repo deleted its numeric import ceilings after five
 * consecutive raises, one of them to accommodate a security fix. A row here has to
 * say what the terminal type is doing, so that removing it is a decision someone
 * makes rather than a number someone bumps.
 */
const MAY_NAME_THE_TERMINAL: Record<string, string> = {
	"legacy-pi-tui-shim.ts":
		"IS the terminal compatibility surface: it re-exports @veyyon/tui wholesale so a pi-era " +
		"plugin keeps resolving. Removing the import would defeat the module's only purpose.",
	"legacy-pi-coding-agent-shim.ts": "Constructs a Text to keep a pi-era rendering path drawing what it used to draw.",
	"extensions/types.ts":
		"Screen-takeover capability: ui.custom(), setHeader() and setEditorComponent() take a live " +
		"TUI, an EditorTheme and a KeybindingsManager as PARAMETERS. Contravariant, so they cannot " +
		"be widened, and a non-terminal host has nothing to pass.",
	"hooks/types.ts": "Same screen-takeover capability, reached through a hook's ctx.ui.custom().",
};

/** Every `.ts` under the published extensibility surface. */
function contractSources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) contractSources(full, found);
		else if (entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

describe("the published plugin contract does not name a terminal", () => {
	const sources = contractSources(EXTENSIBILITY_DIR);
	const naming = sources
		.filter(file => /from\s+"@veyyon\/tui"/.test(fs.readFileSync(file, "utf8")))
		.map(file => path.relative(EXTENSIBILITY_DIR, file).replaceAll(path.sep, "/"))
		.sort();

	it("scans a surface that actually exists", () => {
		// Anti-vacuity: a wrong directory would make every assertion below pass on nothing.
		expect(sources.length).toBeGreaterThan(20);
	});

	it("names the terminal only where a reason is recorded", () => {
		expect(naming).toEqual(Object.keys(MAY_NAME_THE_TERMINAL).sort());
	});

	it("keeps every recorded reason live", () => {
		// A row that stops matching is a row nobody deleted. Pinned by equality in both
		// directions so the map cannot rot into a list of files that no longer exist.
		const stale = Object.keys(MAY_NAME_THE_TERMINAL).filter(rel => !naming.includes(rel));
		expect(stale).toEqual([]);
	});

	it("keeps the tool-plugin contract host-agnostic", () => {
		// The specific regression: `custom-tools/types.ts` typed both of its renderer
		// returns as a `@veyyon/tui` Component, which made every tool plugin a terminal
		// tool plugin. It is the one contract file a GUI most needs, so it is asserted by
		// name rather than left to the map above.
		expect(naming).not.toContain("custom-tools/types.ts");
		const source = fs.readFileSync(path.join(EXTENSIBILITY_DIR, "custom-tools", "types.ts"), "utf8");
		expect(source).toContain("HostView");
	});
});
