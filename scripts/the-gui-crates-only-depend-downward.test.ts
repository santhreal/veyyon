// WHY THIS EXISTS.
//
// `hosts/gui/` is four crates because Cargo enforces a layering a document
// cannot: `core` (no toolkit) <- `kit` (tokens and primitives) <- `features`
// (one directory per surface) <- `app` (the window). The value of that shape is
// entirely in the absence of the reverse edges. One `veyyon-gui-features` line
// in `kit/Cargo.toml` compiles, and from then on a primitive can read app state
// and the layering is decoration.
//
// The second rule with the same property is the file ceiling. The clients this
// front end is measured against carry 7,000-line surface files, and every one
// of them got there one plausible addition at a time. A ceiling only works if
// something counts.
//
// THE CLASS IT CLOSES. A dependency edge inside the gui workspace that is not
// in the layering, a crate added to the workspace with no declared position in
// it, a source file grown past the ceiling, a flex item with no minimum, and a
// scroll region built by hand. Members and edges are read from the manifests at
// run time and the file list is walked at run time, so a new crate or a new
// file fails here rather than being discovered by a reader.
//
// The third rule is the flex floor. A flex item's automatic minimum is its own
// content, so one unbroken run - a URL, a path, a diff line, a quoted fence -
// makes the item as wide as that run and pushes whatever shares the row out
// through the window edge. The floor is one call, `min_w(px(0.0))` for a row,
// `min_h(px(0.0))` for a column, or `overflow_hidden()`, and the defect is
// invisible until a window is narrow enough or a string long enough, which is
// the state a reader never has open.
//
// The fourth is that scrolling and fading are one call. A region that scrolls
// and does not fade cuts a row in half at its edge, which reads as a drawing
// error rather than as content continuing; every such region in this window was
// written by copying a neighbouring one, so half of them would keep the cut.
// `kit::ui::Scrolls` applies gpui's overflow and scroll tracking together with
// the edge fade, and this keeps the gpui calls inside kit so no surface can
// take one without the other. A virtualized region is the same rule through a
// different door: `list()` and `uniform_list()` scroll on state of their own
// rather than on a `ScrollHandle`, which is how the transcript - the largest
// scroll region in the window - was the one with a hard cut at both edges, so
// each one goes through `scrolls_list` or `scrolls_uniform`.
//
// The fifth is that a metric holding a glyph is a function of the interface
// scale and a metric that does not is a constant. A text-size preference that
// multiplies only the type sizes clips every row in the window at the sizes it
// was supposed to help, and the defect is one `pub const` in a token module
// that nobody notices because it reads exactly like its scaling neighbours.
// Both sets are parsed from the token files at run time: a new accessor has to
// appear in kit's scale suite, and a new constant has to be recorded as fixed.
//
// The sixth is that two controls never share a motion track. A track is keyed
// by its owner, so a duplicate `RetainedKey` makes hovering one control light
// another: the sidebar's pin and the toolbar's rename ran on one track, and an
// unkeyed conversation put all six toolbar controls plus the search field on
// one. Keys are no longer picked by hand: a surface names an object through
// `kit::motion::owners`, so this checks that no surface builds a key itself and
// that no slot variant is named by two drawing sites.
//
// WHAT IT DOES NOT CATCH. Whether a module inside a crate belongs to the layer
// it sits in: `features/src/render/` could import a surface and this stays
// green. Nor does it read Rust - a file under the ceiling can still hold two
// concerns, and a floor stated next to `flex_1()` is matched as text, so a
// floor written further down the same chain reads here as missing. Nor which
// ground a fade names: a band of the wrong elevation is a visible stripe and
// only a capture shows it. Nor whether a metric recorded as fixed is right to
// be fixed: that a 256px sidebar holds four words at 24px text is a design
// question, not a rule.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const guiRoot = path.join(repoRoot, "hosts", "gui");

/** What a crate may depend on, and nothing else. Read as: the key's row is its whole world. */
const LAYERING: Record<string, string[]> = {
	"veyyon-gui-core": [],
	"veyyon-gui-kit": ["veyyon-gui-core"],
	"veyyon-gui-features": ["veyyon-gui-core", "veyyon-gui-kit"],
	"veyyon-gui": ["veyyon-gui-core", "veyyon-gui-kit", "veyyon-gui-features"],
};

/** Lines a file may reach. A file at the ceiling is one concern too many, not a long one. */
const CEILING = 400;

/**
 * The files allowed past the ceiling, and how far. A table (icons, keys, a
 * keyword set) is data rather than logic, and splitting one costs a reader the
 * ability to see it at once. Pinned by exact equality: an entry here is a
 * decision somebody made, not a limit that drifted.
 */
const TABLES: Record<string, number> = {};

/** What counts as stating a flex item's minimum. One of these, on the call after `flex_1()`. */
const FLOORS = ["min_w(px(0.0))", "min_h(px(0.0))", "overflow_hidden()"];

/**
 * The gpui scrolling calls, which only kit may name. A surface reaches
 * scrolling through `kit::ui::Scrolls`, which applies these together with the
 * edge fade.
 */
const RAW_SCROLL = ["overflow_y_scroll()", "overflow_x_scroll()", "overflow_scroll()", "track_scroll("];

/** What a surface uses instead. Counted, so removing the mechanism fails too. */
const FADED_SCROLL = [".scrolls_y(", ".scrolls_x(", ".scrolls("];

/**
 * The token files, and the suite that has to drive every accessor in them.
 * Parsed rather than listed: a module added to either file joins the sweep.
 */
const TOKEN_FILES = ["kit/src/theme/tokens.rs", "kit/src/theme/geometry.rs"];
const SCALE_SUITE = "kit/src/theme/a_larger_interface_size_moves_text_and_its_boxes_together.rs";

/**
 * Every metric a token module states as a constant, which is a claim that it
 * holds no glyph. Pinned by exact equality: a new entry is a decision that the
 * window's own geometry does not move with the text, and a constant added
 * without that decision is the defect this arm exists for. Ordered as the
 * files declare them.
 */
const FIXED = [
	"size::CHOICES_PX",
	"size::LINE_CHROME",
	"size::LINE_PROSE",
	"size::LINE_CODE",
	"control::SWITCH_INSET",
	"control::CHECKBOX_BAR",
	"control::FOCUS_RING",
	"layout::TITLEBAR_INSET",
	"layout::MACOS_TRAFFIC_LIGHT_CLEARANCE",
	"layout::WINDOW_CONTROL_HIT",
	"layout::WINDOW_CONTROL_CLUSTER",
	"layout::SIDEBAR",
	"layout::SIDEBAR_MIN",
	"layout::SIDEBAR_MAX",
	"layout::INSPECTOR",
	"layout::INSPECTOR_MIN",
	"layout::INSPECTOR_MAX",
	"layout::BOTTOM_DOCK",
	"layout::BOTTOM_DOCK_MIN",
	"layout::CONVERSATION_WIDE_BREAKPOINT",
	"layout::SHEET",
	"layout::OVERLAY_MARGIN",
	"layout::SHEET_TOP",
	"layout::HANDLE",
	"layout::HANDLE_HIT",
	"layout::CONTROL",
	"layout::SCROLLBAR",
	"layout::MIN_WINDOW_WIDTH",
	"layout::MIN_WINDOW_HEIGHT",
	"layout::BREAKPOINT_INLINE",
	"layout::BREAKPOINT_SIDEBAR_SHEET",
	"diff::SPLIT_DIVIDER",
	"diff::NARROW_INSPECTOR",
];

/**
 * The token modules that scale, with what each declares. A module counts as
 * scaling when it states at least one accessor, so the set follows the files
 * rather than a list here; `weight`, `space`, `radius` and `opacity` state
 * none and are a ratio, a gap, a corner and an alpha, which no text size
 * changes.
 */
function tokenModules(): { module: string; accessors: string[]; constants: string[] }[] {
	const parsed: { module: string; accessors: string[]; constants: string[] }[] = [];
	for (const relative of TOKEN_FILES) {
		let open: { module: string; accessors: string[]; constants: string[] } | undefined;
		for (const line of readFileSync(path.join(guiRoot, relative), "utf8").split("\n")) {
			const declared = /^pub mod ([a-z_]+) \{/.exec(line);
			if (declared) {
				open = { module: declared[1] as string, accessors: [], constants: [] };
				parsed.push(open);
				continue;
			}
			if (line === "}") {
				open = undefined;
				continue;
			}
			if (!open) {
				continue;
			}
			const accessor = /^\tpub fn ([a-z_0-9]+)\(\) -> f32/.exec(line);
			if (accessor) {
				open.accessors.push(accessor[1] as string);
			}
			const constant = /^\tpub const ([A-Z][A-Z0-9_]*)\s*:/.exec(line);
			if (constant) {
				open.constants.push(constant[1] as string);
			}
		}
	}
	expect(parsed.length).toBeGreaterThan(5);
	return parsed.filter(module => module.accessors.length > 0);
}

/** Every gui source file, path relative to `hosts/gui` with forward slashes. */
function sources(): string[] {
	return [...new Bun.Glob("*/src/**/*.rs").scanSync({ cwd: guiRoot })].map(hit => hit.replace(/\\/g, "/")).sort();
}

type Manifest = {
	package?: { name?: string };
	workspace?: { members?: string[] };
	dependencies?: Record<string, unknown>;
	"dev-dependencies"?: Record<string, unknown>;
	"build-dependencies"?: Record<string, unknown>;
};

/** Bun.TOML: node has no TOML parser, and one manifest read is not worth a dependency. */
function manifestOf(dir: string): Manifest {
	return Bun.TOML.parse(readFileSync(path.join(dir, "Cargo.toml"), "utf8")) as Manifest;
}

/** The workspace members, from the manifest rather than from a list written here. */
function members(): { directory: string; name: string; manifest: Manifest }[] {
	const root = manifestOf(guiRoot);
	const declared = root.workspace?.members ?? [];
	expect(declared.length).toBeGreaterThan(0);

	return declared.map(member => {
		const directory = path.join(guiRoot, member);
		const manifest = manifestOf(directory);
		const name = manifest.package?.name;
		expect(typeof name, `${member} declares no package name`).toBe("string");
		return { directory, name: name as string, manifest };
	});
}

/** Every dependency of a crate that is one of the workspace's own. */
function inwardEdges(manifest: Manifest, own: Set<string>): string[] {
	const sections = [manifest.dependencies, manifest["dev-dependencies"], manifest["build-dependencies"]];
	const found = new Set<string>();
	for (const section of sections) {
		for (const name of Object.keys(section ?? {})) {
			if (own.has(name)) {
				found.add(name);
			}
		}
	}
	return [...found].sort();
}

describe("the gui crates only depend downward", () => {
	// The whole point of splitting the layers into crates. A row missing from
	// LAYERING is a crate whose position nobody declared, which is the state
	// this test exists to make impossible.
	test("every member has a declared position in the layering", () => {
		expect(
			members()
				.map(member => member.name)
				.sort(),
		).toEqual(Object.keys(LAYERING).sort());
	});

	// Read from the manifests, so an edge added to Cargo.toml fails here before
	// it is built on. Dev-dependencies count: a test that reaches upward gives
	// the upward type a reason to stay reachable.
	test("no crate depends on a layer above it", () => {
		const own = new Set(Object.keys(LAYERING));
		for (const { name, manifest } of members()) {
			const allowed = LAYERING[name] ?? [];
			expect(inwardEdges(manifest, own), `${name} reaches outside its layer`).toEqual([...allowed].sort());
		}
	});

	// `core` compiles without a GPU, a display or a font, which is what makes
	// its suites run in milliseconds and its logic testable without a window.
	// One gpui line takes all of that away.
	test("the core crate names no toolkit", () => {
		const core = members().find(member => member.name === "veyyon-gui-core");
		expect(core, "veyyon-gui-core is not a member").toBeDefined();

		const named = [
			...Object.keys(core?.manifest.dependencies ?? {}),
			...Object.keys(core?.manifest["dev-dependencies"] ?? {}),
		];
		expect(named.filter(name => name.startsWith("gpui"))).toEqual([]);
	});

	// Walked at run time. A ceiling checked against a list of files is a
	// ceiling that stops applying to the next file somebody adds.
	test("no source file is over the ceiling", () => {
		const over: string[] = [];
		let counted = 0;

		for (const relative of sources()) {
			const lines = readFileSync(path.join(guiRoot, relative), "utf8").split("\n").length;
			const limit = TABLES[relative] ?? CEILING;
			counted += 1;
			if (lines > limit) {
				over.push(`${relative}: ${lines} lines, limit ${limit}`);
			}
		}

		expect(counted).toBeGreaterThan(50);
		expect(over).toEqual([]);
	});

	// An exemption is a decision, so it is pinned rather than counted. This
	// also fails when an exempted file is split and its entry is left behind,
	// which is the state that quietly raises the ceiling for whatever takes its
	// path next.
	test("every file exempted from the ceiling is still there and still needs it", () => {
		expect(Object.keys(TABLES)).toEqual([]);
	});

	// Walked at run time for the same reason as the ceiling: the next flex item
	// somebody writes is the one this is for. A row of two children where the
	// text has no floor is a row that stops shrinking at the width of its
	// longest word, and the button beside it leaves the window rather than the
	// text getting shorter.
	test("every flex item states its minimum", () => {
		const unfloored: string[] = [];
		let items = 0;

		for (const relative of sources()) {
			const lines = readFileSync(path.join(guiRoot, relative), "utf8").split("\n");
			lines.forEach((line, index) => {
				if (!line.includes("flex_1()")) {
					return;
				}
				items += 1;
				const chain = `${line}${lines[index + 1] ?? ""}`;
				if (!FLOORS.some(floor => chain.includes(floor))) {
					unfloored.push(`${relative}:${index + 1}: ${line.trim()}`);
				}
			});
		}

		expect(items).toBeGreaterThan(15);
		expect(unfloored).toEqual([]);
	});

	// Walked at run time, and counted in both directions: the raw calls have
	// to be absent AND the replacement has to be present, so deleting every
	// fade in the tree fails here rather than reading as a clean sweep.
	test("a scroll region outside kit scrolls and fades in one call", () => {
		const raw: string[] = [];
		let faded = 0;

		for (const relative of sources()) {
			if (relative.startsWith("kit/")) {
				continue;
			}
			const lines = readFileSync(path.join(guiRoot, relative), "utf8").split("\n");
			lines.forEach((line, index) => {
				if (RAW_SCROLL.some(call => line.includes(call))) {
					raw.push(`${relative}:${index + 1}: ${line.trim()}`);
				}
				if (FADED_SCROLL.some(call => line.includes(call))) {
					faded += 1;
				}
			});
		}

		expect(raw).toEqual([]);
		expect(faded).toBeGreaterThan(10);
	});

	// The same rule for a region that scrolls on state of its own. The import
	// is the door: a file that names gpui's `list` or `uniform_list` builds a
	// virtualized region, and the only way to draw one here is through the kit
	// helper that fades it. Counted, so deleting the helpers fails too.
	test("a virtualized region outside kit is faded through kit", () => {
		const unfaded: string[] = [];
		let wired = 0;

		for (const relative of sources()) {
			if (relative.startsWith("kit/")) {
				continue;
			}
			const source = readFileSync(path.join(guiRoot, relative), "utf8");
			const imports = /use gpui::\{([^}]*)\}/s.exec(source)?.[1] ?? "";
			const builds = [
				["list", "scrolls_list("],
				["uniform_list", "scrolls_uniform("],
			] as const;
			for (const [element, helper] of builds) {
				if (!new RegExp(`(^|[\\s,])${element}([\\s,]|$)`).test(imports)) {
					continue;
				}
				if (source.includes(helper)) {
					wired += 1;
				} else {
					unfaded.push(`${relative}: builds ${element}() without ${helper}`);
				}
			}
		}

		expect(unfaded).toEqual([]);
		expect(wired).toBeGreaterThan(2);
	});

	// Parsed from the token files, so a module added to either one joins the
	// sweep. The suite is kit's, and it drives each accessor at every size a
	// reader can pick; an accessor it never names is a metric nobody has seen
	// at any size but the default.
	test("kit's scale suite drives every token accessor", () => {
		const suite = readFileSync(path.join(guiRoot, SCALE_SUITE), "utf8");
		const untested: string[] = [];
		let accessors = 0;

		for (const { module, accessors: names } of tokenModules()) {
			for (const name of names) {
				accessors += 1;
				if (!suite.includes(`("${module}::${name}", ${module}::${name})`)) {
					untested.push(`${module}::${name}`);
				}
			}
		}

		expect(accessors).toBeGreaterThan(40);
		expect(untested).toEqual([]);
	});

	// The arm that fails by default. A metric stated as a constant in a scaling
	// module claims to hold no glyph, and the claim is wrong more often than it
	// is right: this goes red on the next one until somebody records it.
	test("every metric a scaling token module states as fixed is recorded", () => {
		const stated: string[] = [];
		for (const { module, constants } of tokenModules()) {
			for (const name of constants) {
				stated.push(`${module}::${name}`);
			}
		}
		expect(stated).toEqual(FIXED);
	});

	// The same set from the other side: a surface reaching a scaling module for
	// a name in capitals is either reading a recorded constant or reading a
	// metric that stopped scaling, and the second is invisible in a diff.
	test("no surface reads a scaling token that is not recorded as fixed", () => {
		const scaling = tokenModules().map(module => module.module);
		// The trailing lookahead keeps a type out of the sweep: `diff::FileDiff`
		// and `icon::Icon` are names these modules also export, and only a name
		// that is capitals the whole way is a metric.
		const reach = new RegExp(`\\b(${scaling.join("|")})::([A-Z][A-Z0-9_]*)\\b(?![a-z])`, "g");
		const unrecorded: string[] = [];

		for (const relative of sources()) {
			if (TOKEN_FILES.includes(relative)) {
				continue;
			}
			const lines = readFileSync(path.join(guiRoot, relative), "utf8").split("\n");
			lines.forEach((line, index) => {
				for (const [, module, name] of line.matchAll(reach)) {
					if (!FIXED.includes(`${module}::${name}`)) {
						unrecorded.push(`${relative}:${index + 1}: ${module}::${name}`);
					}
				}
			});
		}

		expect(unrecorded).toEqual([]);
	});

	// A scale nothing installs is a preference that changes nothing. One call
	// site outside kit, in the frame, reading the store's own preference:
	// counted, so deleting it fails here rather than in a capture nobody takes.
	test("the frame installs the reader's text size from the preference", () => {
		const installs: string[] = [];

		for (const relative of sources()) {
			if (relative.startsWith("kit/")) {
				continue;
			}
			const source = readFileSync(path.join(guiRoot, relative), "utf8");
			if (source.includes("set_base_font(")) {
				installs.push(relative);
				expect(source, `${relative} installs a size that is not the preference`).toContain(
					"preferences.font_size_milli_px",
				);
			}
		}

		expect(installs).toEqual(["app/src/shell/frame.rs"]);
	});

	// Two names for one metric is how a surface ends up reading the token that
	// stopped being the one the designer changes: a caller of `size::small()`
	// does not see `size::meta()` move under it. An alias whose whole body is
	// another token in the same module is pinned by exact equality below, so
	// the next one turns this red until somebody states the relation.
	test("a token has one name", () => {
		const aliases: string[] = [];

		for (const relative of TOKEN_FILES) {
			const lines = readFileSync(path.join(guiRoot, relative), "utf8").split("\n");
			let module = "";
			lines.forEach((line, index) => {
				const declared = /^pub mod ([a-z_]+) \{/.exec(line);
				if (declared) {
					module = declared[1] as string;
					return;
				}
				const accessor = /^\tpub fn ([a-z_0-9]+)\(\) -> f32/.exec(line);
				if (accessor) {
					// A body of one bare call forwards to a sibling; `scaled(PX)`
					// and any arithmetic state a metric of their own.
					const forwards = /^\t\t([a-z_0-9]+)\(\)$/.exec(lines[index + 1] ?? "");
					if (forwards) {
						aliases.push(`${module}::${accessor[1]} = ${module}::${forwards[1]}`);
					}
					return;
				}
				const constant = /^\tpub const ([A-Z][A-Z0-9_]*)\s*:[^=]+=\s*([A-Z][A-Z0-9_]*);/.exec(line);
				if (constant) {
					aliases.push(`${module}::${constant[1]} = ${module}::${constant[2]}`);
				}
			});
		}

		// The spacing ladder is the steps, and these are the names a surface
		// asks for: a pair, a row gap, the ordinary gap. Each is a stated
		// relation to a step, and a step it can be moved off.
		expect(aliases).toEqual([
			"space::PAIR = space::X2",
			"space::ROWS = space::X2",
			"space::TIGHT = space::X4",
			"space::SNUG = space::X6",
			"space::BASE = space::X10",
			"space::WIDE = space::X16",
			"space::LOOSE = space::X20",
			"space::HUGE = space::X32",
		]);
	});

	// A motion track is keyed by its owner, so two controls a window can draw at
	// the same time must not resolve to one key: hovering either lights both. A
	// surface therefore never builds a key: it names the object and lets
	// `kit::motion::owners` allocate the block. A hand-built key is what the
	// numbers were, and every collision came from two files picking one.
	test("no surface builds a motion key by hand", () => {
		const built: string[] = [];
		let named = 0;

		for (const relative of sources()) {
			if (relative.startsWith("kit/")) {
				continue;
			}
			const source = readFileSync(path.join(guiRoot, relative), "utf8");
			for (const [, builder] of source.matchAll(/RetainedKey::(semantic|scoped|new)\(/g)) {
				built.push(`${relative}: RetainedKey::${builder}`);
			}
			if (
				/\bowner\(\s*(?:NS|OwnerNamespace::)/.test(source) ||
				/\bcontrol\(\s*(?:NS|OwnerNamespace::)/.test(source)
			) {
				named += 1;
			}
		}

		expect(named, "no surface names an object; the scan stopped matching").toBeGreaterThan(5);
		expect(built).toEqual([]);
	});

	// The other half: a slot enum names one control each, and a variant used
	// twice puts two controls on one track without repeating an id anywhere. The
	// enums and the files that declare them are read at run time, so a slot
	// added to any surface joins the sweep.
	test("no two controls share a slot", () => {
		const declarations = new Map<string, string>();
		for (const relative of sources()) {
			const source = readFileSync(path.join(guiRoot, relative), "utf8");
			for (const [, name] of source.matchAll(/pub enum (\w*(?:ControlSlot|RowSlot|ChipSlot))\b/g)) {
				declarations.set(`${relative}:${name}`, name as string);
			}
		}

		expect(declarations.size, "no slot enum was found; the scan stopped matching").toBeGreaterThan(2);
		const collisions: string[] = [];

		for (const [declaredIn, name] of declarations) {
			const declaration = declaredIn.slice(0, declaredIn.lastIndexOf(":"));
			const surface = declaration.slice(0, declaration.lastIndexOf("/"));
			const uses = new Map<string, string[]>();
			for (const relative of sources()) {
				if (relative === declaration || !relative.startsWith(`${surface}/`) || relative.includes("/every_")) {
					continue;
				}
				const source = readFileSync(path.join(guiRoot, relative), "utf8");
				for (const [, variant] of source.matchAll(new RegExp(`${name}::(\\w+)`, "g"))) {
					uses.set(variant as string, [...(uses.get(variant as string) ?? []), relative]);
				}
			}
			for (const [variant, sites] of uses) {
				if (sites.length > 1) {
					collisions.push(`${name}::${variant} in ${sites.join(", ")}`);
				}
			}
		}

		expect(collisions).toEqual([]);
	});
});
