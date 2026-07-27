/**
 * One version per dependency across the workspace, decided in one place.
 *
 * WHY THIS SUITE EXISTS. The root `package.json` carries `workspaces.catalog`, and a package that
 * writes `"react": "catalog:"` takes whatever version the catalog names. A package that writes a
 * literal range instead bypasses that entirely, and the failure is silent in both directions: today
 * the literal happens to resolve to the same version the catalog names, so nothing looks wrong, and
 * the day the catalog moves, that one package quietly stays behind. Nothing warns, no gate fails, and
 * the divergence shows up later as one package type-checking against a different `@types/react` than
 * the package importing it.
 *
 * Four literals had already accumulated that way — `metaharness` pinned the whole react family at
 * `^19.1.0` while the catalog said `19.2.7`/`^19.2.17`, `swarm-extension` pinned `@types/bun` at
 * `^1.3.14`, and `mnemopi` declared a peer `onnxruntime-node` of `1.21.0` against a catalog `1.26.0`.
 * `fast-check` was worse: copy-pinned identically in four packages and absent from the catalog, so
 * there was no single place to change it at all.
 *
 * Peer dependencies are deliberately NOT required to be `catalog:`. A published package's peer range
 * is read by consumers outside this workspace, where `catalog:` means nothing, so it has to be a real
 * semver range. What it must not do is disagree with the catalog, and that is what the peer test below
 * asserts instead.
 *
 * The version assertions at the end are a characterization lock, not a preference. Repointing a
 * literal at the catalog is only safe if it does not move the resolved version, so the versions the
 * lockfile settled on are written down here: a future catalog bump has to change this file too, which
 * makes the bump visible in review rather than arriving as a lockfile hunk nobody reads.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

/** Fields whose entries are resolved for THIS workspace, so `catalog:` is usable in them. */
const RESOLVED_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

interface PackageManifest {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	workspaces?: { catalog?: Record<string, string> };
}

function readManifest(file: string): PackageManifest {
	return JSON.parse(readFileSync(file, "utf-8")) as PackageManifest;
}

const catalog: Record<string, string> = readManifest(path.join(repoRoot, "package.json")).workspaces?.catalog ?? {};

/** Every workspace package under `packages/`, by its manifest path. */
function workspaceManifests(): Array<{ rel: string; manifest: PackageManifest }> {
	const packagesDir = path.join(repoRoot, "packages");
	const found: Array<{ rel: string; manifest: PackageManifest }> = [];
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const file = path.join(packagesDir, entry.name, "package.json");
		try {
			found.push({ rel: `packages/${entry.name}/package.json`, manifest: readManifest(file) });
		} catch {
			// `packages/` holds one non-package entry (the shared tsconfig), which has no manifest.
			// Skipping it is correct here; ORG-XP-5 owns whether it should live there at all.
		}
	}
	return found;
}

/** A spec that names a version rather than deferring to the catalog or the workspace. */
function isLiteralVersion(spec: string): boolean {
	return (
		!spec.startsWith("catalog:") &&
		!spec.startsWith("workspace:") &&
		!spec.startsWith("file:") &&
		!spec.startsWith("link:")
	);
}

const manifests = workspaceManifests();

describe("the catalog is the only place a shared version is written", () => {
	it("has no package pinning a catalogued dependency with a literal range", () => {
		// The lock. A literal that agrees with the catalog today is the exact shape the four
		// migrated pins had, so agreement is not a defence: the offence is having a second place
		// to change.
		const offenders: string[] = [];
		for (const { rel, manifest } of manifests) {
			for (const field of RESOLVED_FIELDS) {
				for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
					if (!(name in catalog) || !isLiteralVersion(spec)) continue;
					offenders.push(`${rel} [${field}] ${name} = "${spec}" (catalog: "${catalog[name]}")`);
				}
			}
		}

		expect(offenders, 'use "catalog:" — the root package.json workspaces.catalog owns this version').toEqual([]);
	});

	it("has no dependency used by two or more packages that is absent from the catalog", () => {
		// `fast-check` was copy-pinned in four packages with no catalog entry, so "bump it" meant
		// four edits and three chances to forget one. A dependency crossing package boundaries
		// belongs in the catalog by definition.
		const users = new Map<string, string[]>();
		for (const { rel, manifest } of manifests) {
			for (const field of RESOLVED_FIELDS) {
				for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
					if (name in catalog || !isLiteralVersion(spec)) continue;
					const seen = users.get(name) ?? [];
					if (!seen.includes(rel)) seen.push(rel);
					users.set(name, seen);
				}
			}
		}
		const shared = [...users.entries()]
			.filter(([, where]) => where.length >= 2)
			.map(([name, where]) => `${name} in ${where.join(", ")}`);

		expect(shared, "add to workspaces.catalog in the root package.json and use catalog: in each package").toEqual([]);
	});

	it("keeps every peer range in agreement with the catalog", () => {
		// Peer ranges stay literal on purpose: a consumer outside this workspace cannot resolve
		// `catalog:`. Drift is still a defect — mnemopi declared a peer `onnxruntime-node` of
		// 1.21.0 while its own devDependency resolved 1.26.0, so the version it was tested
		// against and the version it advertised were different.
		const drifted: string[] = [];
		for (const { rel, manifest } of manifests) {
			for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) {
				if (!(name in catalog) || !isLiteralVersion(spec)) continue;
				if (spec !== catalog[name]) drifted.push(`${rel} peer ${name} = "${spec}", catalog "${catalog[name]}"`);
			}
		}

		expect(drifted, "a peer range must name the same version the catalog resolves").toEqual([]);
	});
});

describe("the catalog versions the migration was verified against", () => {
	// Characterization. Repointing a literal at the catalog is safe only if the resolved version
	// does not move; these are the versions `bun install` produced with the literals still in
	// place, so a catalog bump has to edit this file and become visible in review.
	const expected: Record<string, string> = {
		react: "19.2.7",
		"react-dom": "19.2.7",
		"@types/react": "^19.2.17",
		"@types/react-dom": "^19.2.3",
		"@types/bun": "^1.3.14",
		"fast-check": "4.9.0",
		// Moved 1.26.0 -> 1.21.0 deliberately, which is the review this table exists to force.
		// `fastembed@2.1.0` declares an exact `onnxruntime-node: 1.21.0` and its native addon links
		// against the ORT it ships with, so the catalog installing 1.26.0 meant the tree developed
		// against one ORT while `@veyyon/mnemopi` advertised a peer of the other. The peer pin, the
		// catalog and fastembed's own dependency are one version now; `fastembed-runtime.test.ts`
		// reads that dependency rather than a literal, so the next fastembed bump reports the pair.
		"onnxruntime-node": "1.21.0",
		fastembed: "2.1.0",
	};

	for (const [name, version] of Object.entries(expected)) {
		it(`still names ${name} ${version}`, () => {
			expect(catalog[name]).toBe(version);
		});
	}
});

describe("the lockfile", () => {
	it("resolves exactly one top-level version for each migrated dependency", () => {
		// The proof that the catalog is doing what the pins used to do. A second top-level entry
		// for one of these names would mean two versions installed side by side, which is the
		// outcome the whole change exists to prevent. Nested entries (`fastembed/onnxruntime-node`)
		// are a dependency's own private resolution and are not this contract's business.
		const lock = readFileSync(path.join(repoRoot, "bun.lock"), "utf-8");
		for (const name of ["react", "react-dom", "@types/react", "@types/bun", "fast-check", "onnxruntime-node"]) {
			const entries = [
				...lock.matchAll(new RegExp(`^\\s*"${name.replace("/", "\\/")}": \\["${name}@([^"]+)"`, "gm")),
			];
			expect(entries.length, `top-level lockfile entries for ${name}`).toBe(1);
		}
	});

	it("resolves the react family to the single version the catalog names", () => {
		const lock = readFileSync(path.join(repoRoot, "bun.lock"), "utf-8");
		expect(lock).toContain('"react": ["react@19.2.7"');
		expect(lock).toContain('"react-dom": ["react-dom@19.2.7"');
		expect(lock).toContain('"fast-check": ["fast-check@4.9.0"');
	});
});
