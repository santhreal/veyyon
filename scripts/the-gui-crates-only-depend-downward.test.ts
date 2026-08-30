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
// it, and a source file grown past the ceiling. Members and edges are read from
// the manifests at run time and the file list is walked at run time, so a new
// crate or a new file fails here rather than being discovered by a reader.
//
// WHAT IT DOES NOT CATCH. Whether a module inside a crate belongs to the layer
// it sits in: `features/src/render/` could import a surface and this stays
// green. Nor does it read Rust — a file under the ceiling can still hold two
// concerns.

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

		for (const hit of new Bun.Glob("*/src/**/*.rs").scanSync({ cwd: guiRoot })) {
			const relative = hit.replace(/\\/g, "/");
			const lines = readFileSync(path.join(guiRoot, hit), "utf8").split("\n").length;
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
});
