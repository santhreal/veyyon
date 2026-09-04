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
 *   terminal-only: a GUI has no `TUI` to hand over. So they are not widened and
 *   they are not left on the contract either — they live in
 *   `terminal-capability.ts` behind an optional `ui.terminal`, which a host
 *   offers or omits.
 *
 * That last move is what the flat interface was hiding. While the members sat on
 * `ExtensionUIContext`, every headless host had to declare them anyway, so RPC,
 * ACP, the subagent runner and the session default all carried empty bodies and
 * `custom: async () => undefined as never`. `setHeader` and `setFooter` turned
 * out to be `() => {}` in all six hosts, interactive included, and were deleted
 * rather than moved.
 *
 * The takeover half is checked twice, because neither check sees the other's
 * failure. `Declares<>` fails `bun run check:ts` when a context DECLARES a
 * takeover member again; the last cell fails when the constructible headless
 * host IMPLEMENTS one. A member declared optional and never implemented passes
 * the second and fails the first.
 *
 * WHAT THIS DOES NOT CATCH. It reads imports and line shapes, not meaning. A
 * contract file could describe a terminal in prose, or take a structurally
 * terminal-shaped object it declares itself, and this stays green. A host could
 * also offer `ui.terminal` and then throw from every member; the contract says
 * what a host may offer, not that it works. Only the session default is driven
 * as an object -- RPC, ACP and the runner build their contexts inside a running
 * mode -- so a takeover member re-implemented in one of those three is caught by
 * the type half alone. It says nothing about the 69 files outside
 * `src/extensibility/` that import `@veyyon/tui`; those are veyyon's own code,
 * not the published contract, and they are a separate problem.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionWidgetContent } from "@veyyon/kernel/registry/widget";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import type { HookUIContext } from "../../src/extensibility/hooks/types";
import type {
	ExtensionTerminalCapability,
	ExtensionUiComponentFactory,
} from "../../src/extensibility/terminal-capability";
import { createNoOpUIContext } from "../../src/extensibility/utils";

const EXTENSIBILITY_DIR = path.join(import.meta.dir, "..", "..", "src", "extensibility");

/** The kernel's contribution registry, which owns the host-agnostic view declaration. */
const KERNEL_REGISTRY_DIR = path.join(import.meta.dir, "..", "..", "..", "..", "kernel", "src", "registry");

/** The subpath every renderer contract imports `HostView` through. */
const HOST_VIEW_SPECIFIER = "@veyyon/kernel/registry/host-view";

/**
 * Every member that took a terminal, listed by name because that is what a host had to
 * implement. Two of them -- `setHeader` and `setFooter` -- no longer exist anywhere: they
 * were `() => {}` in all six hosts, so they were deleted rather than moved behind the
 * capability, and they stay here so reintroducing one is a decision rather than a drift.
 */
const TAKEOVER_MEMBERS = ["custom", "setEditorComponent", "setWidgetComponent", "setHeader", "setFooter"] as const;
type TakeoverMember = (typeof TAKEOVER_MEMBERS)[number];

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
	"terminal-capability.ts":
		"IS the screen-takeover capability, declared apart from the contract and named for what " +
		"it is: custom(), setWidgetComponent() and setEditorComponent() take a live TUI, an " +
		"EditorTheme and a KeybindingsManager as PARAMETERS. Contravariant, so they cannot be " +
		"widened, and a non-terminal host has nothing to pass -- so it omits `ui.terminal` instead.",
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

	it("declares the host-agnostic view once, and points both renderer contracts at it", () => {
		// The drift this blocks: a contract widened by writing `unknown` inline instead of
		// importing the shared declaration. Both spellings type-check and both look
		// host-agnostic, but a second one has nowhere to carry the reasoning, and the two
		// then diverge the first time the type gains structure. `@veyyon/kernel/registry/host-view`
		// is the one declaration; a renderer contract that does not import it is drifting.
		const declaration = fs.readFileSync(path.join(KERNEL_REGISTRY_DIR, "host-view.ts"), "utf8");
		expect(declaration).toMatch(/export type HostView\b/);
		expect(declaration).not.toMatch(/from "@veyyon\/tui"/);

		for (const contract of ["custom-tools/types.ts", "extensions/types.ts", "hooks/types.ts"]) {
			const source = fs.readFileSync(path.join(EXTENSIBILITY_DIR, ...contract.split("/")), "utf8");
			expect(source).toContain(`import type { HostView } from "${HOST_VIEW_SPECIFIER}";`);
			expect(source).toContain("=> HostView;");
		}
	});

	it("returns a terminal node only from the screen-takeover capability", () => {
		// The class, rather than the renderers that happened to be wrong: sweep every arrow
		// that returns a terminal node type anywhere in the published surface, and pin the
		// result. A renderer typed `=> Component` fails here even if its file already imports
		// `@veyyon/tui` for another reason, which is precisely the case the import-level check
		// above cannot see. `CustomEditor` is in the sweep because `setEditorComponent` returns
		// one, so a contract that grew a second editor hook could not slip past a pattern
		// written only for `Component`.
		const RETURNS_A_TERMINAL_NODE = /=>\s*\(?(?:Component|ExtensionUiComponent|CustomEditor)\b/;
		const returning = sources
			.flatMap(file => {
				const rel = path.relative(EXTENSIBILITY_DIR, file).replaceAll(path.sep, "/");
				return fs
					.readFileSync(file, "utf8")
					.split("\n")
					.flatMap(line => (RETURNS_A_TERMINAL_NODE.test(line) ? [rel] : []));
			})
			.sort();

		// All four are in the capability module, and none in a context interface: the widget
		// factory alias, the two `custom(factory)` forms that hand a live `TUI` to the caller,
		// and the editor factory. Screen takeover is terminal by construction, and a host that
		// is not a terminal offers no `ui.terminal` at all rather than declaring these and
		// leaving the bodies empty.
		expect(returning).toEqual([
			"terminal-capability.ts",
			"terminal-capability.ts",
			"terminal-capability.ts",
			"terminal-capability.ts",
		]);
	});

	it("keeps the screen-takeover capability off every context a host must implement", () => {
		// The regression this closes is the one the split fixed: a terminal-only member
		// declared on the flat context, which every headless host then had to satisfy with an
		// empty body or `undefined as never`. This drives the constructible headless host --
		// the session default -- rather than reading its source, so a member re-added to the
		// contract and implemented here goes red on the object, not on a line shape.
		const headless: HookUIContext = createNoOpUIContext();
		const reachable = new Set<string>();
		for (
			let proto: object | null = headless;
			proto !== null && proto !== Object.prototype;
			proto = Object.getPrototypeOf(proto)
		) {
			for (const name of Object.getOwnPropertyNames(proto)) reachable.add(name);
		}
		expect(TAKEOVER_MEMBERS.filter(member => reachable.has(member))).toEqual([]);
		// It offers no capability handle either: absence is how a host reports what it cannot do.
		expect(reachable.has("terminal")).toBe(false);
	});
});

/**
 * The compile-time half. The cell above can only see what a host implements; these
 * see what the contract DECLARES, which is what forces a host's hand in the first
 * place. Re-adding `custom` to either context flips its `Declares` to `true` and
 * `bun run check:ts` fails on the assignment, before any test runs.
 */
type Declares<T, K extends string> = K extends keyof T ? true : false;

const _extensionContextDeclaresNoTakeover: {
	[K in TakeoverMember]: Declares<ExtensionUIContext, K>;
} = { custom: false, setEditorComponent: false, setWidgetComponent: false, setHeader: false, setFooter: false };

const _hookContextDeclaresNoTakeover: {
	[K in TakeoverMember]: Declares<HookUIContext, K>;
} = { custom: false, setEditorComponent: false, setWidgetComponent: false, setHeader: false, setFooter: false };

// Both contexts reach the capability, so the split is a move rather than a deletion.
const _extensionContextReachesTheCapability: Declares<ExtensionUIContext, "terminal"> = true;
const _hookContextReachesTheCapability: Declares<HookUIContext, "terminal"> = true;

// And the capability carries what the contexts gave up -- otherwise "moved" would be a
// deletion nobody noticed -- while `setHeader`/`setFooter` stay gone. They were `() => {}`
// in all six hosts, so relocating them here instead of deleting them would have kept a dead
// flag alive at a new address.
const _capabilityCarriesTakeover: {
	[K in "custom" | "setEditorComponent" | "setWidgetComponent"]: Declares<ExtensionTerminalCapability, K>;
} = { custom: true, setEditorComponent: true, setWidgetComponent: true };

const _capabilityIsNotWhereDeadFlagsGo: {
	[K in "setHeader" | "setFooter"]: Declares<ExtensionTerminalCapability, K>;
} = { setHeader: false, setFooter: false };

// The widget slot was one member taking `string[] | factory`, which only a terminal could
// honour in full: RPC carried a factory branch it could never run. It is now the
// host-agnostic `setWidget` plus the capability's `setWidgetComponent`, and this fails if
// the factory is ever readmitted to the host-agnostic half.
const _widgetContentIsHostAgnostic: ExtensionUiComponentFactory extends ExtensionWidgetContent ? false : true = true;
