/**
 * What every crate in this workspace must agree with the root manifest about.
 *
 * A Cargo workspace does not enforce that its members use `[workspace.package]`
 * or `[workspace.dependencies]`. A crate can pin its own version and its own
 * copy of a shared dependency, cargo resolves it happily, and the skew is
 * invisible until the day somebody bumps the workspace pin and one crate keeps
 * the old one. That is not hypothetical here: three crates sat outside both
 * tables for months, and `veyyon-uu-grep` ended up building `serde_json`
 * WITHOUT the workspace's `preserve_order` feature, which changed the key order
 * of a JSON record the tool prints.
 *
 * This module reads the manifests as data so a test can assert the contract.
 * It is a plain line parser rather than a TOML library because the questions are
 * narrow (does this key inherit, is this dependency declared locally) and the
 * shapes it must recognize are few and pinned by tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The repository root, found from this file rather than the process cwd. */
export const repoRoot = path.resolve(import.meta.dir, "..");

/** One crate manifest, as much of it as the contract needs. */
export interface CrateManifest {
	/** Directory name under `crates/`, which is also how the path dep spells it. */
	dir: string;
	/** The `name` field, which should match the directory. */
	name: string;
	/** Raw text of the `version` line's value, e.g. `"0.8.0"` or `workspace = true`. */
	version: string;
	/** Every dependency name mapped to its declaration text, all sections merged. */
	dependencies: Map<string, string>;
}

/** The value of a top-level `key = ...` line inside the `[package]` table. */
function packageField(text: string, key: string): string {
	const table = text.split(/^\[/m).find(chunk => chunk.startsWith("package]"));
	if (table === undefined) return "";
	for (const line of table.split("\n")) {
		const match = line.match(new RegExp(`^${key}(?:\\.workspace)?\\s*=\\s*(.+)$`));
		if (match) return line.includes(".workspace") ? "workspace = true" : match[1].trim();
	}
	return "";
}

/**
 * Every dependency declaration in the manifest, from every dependency table.
 *
 * `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` and their
 * `[target.'cfg(...)'.dependencies]` forms all count: a target-specific local
 * pin skews exactly as badly as an ordinary one, and `veyyon-uutils-ctx` kept
 * its `libc` pin in one.
 */
function dependencyLines(text: string): Map<string, string> {
	const found = new Map<string, string>();
	let inDeps = false;
	for (const line of text.split("\n")) {
		const header = line.match(/^\[([^\]]+)\]/);
		if (header) {
			inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(header[1]);
			continue;
		}
		if (!inDeps) continue;
		const match = line.match(/^([A-Za-z0-9_-]+)(\.workspace)?\s*=\s*(.+)$/);
		if (match) found.set(match[1], `${match[2] ?? ""} = ${match[3].trim()}`);
	}
	return found;
}

/** Read one crate manifest by directory name. */
export function readCrateManifest(dir: string): CrateManifest {
	const text = fs.readFileSync(path.join(repoRoot, "crates", dir, "Cargo.toml"), "utf8");
	return {
		dir,
		name: packageField(text, "name").replace(/"/g, ""),
		version: packageField(text, "version"),
		dependencies: dependencyLines(text),
	};
}

/**
 * Every first-party crate directory, which is `crates/*` without the vendored
 * tree.
 *
 * `crates/vendor/**` is deliberately excluded: those are read-only snapshots of
 * upstream crates held to upstream's conventions, and rewriting their manifests
 * to inherit ours would be an edit to vendored code.
 */
export function firstPartyCrateDirs(): string[] {
	return fs
		.readdirSync(path.join(repoRoot, "crates"), { withFileTypes: true })
		.filter(entry => entry.isDirectory() && entry.name !== "vendor")
		.map(entry => entry.name)
		.sort();
}

/** The names declared under the root `[workspace.dependencies]` table. */
export function workspaceDependencyNames(): Set<string> {
	const text = fs.readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8");
	const table = text.split(/^\[/m).find(chunk => chunk.startsWith("workspace.dependencies]"));
	if (table === undefined) throw new Error("root Cargo.toml has no [workspace.dependencies]");
	const names = new Set<string>();
	for (const line of table.split("\n")) {
		const match = line.match(/^([A-Za-z0-9_-]+)\s*=/);
		if (match) names.add(match[1]);
	}
	return names;
}

/**
 * A dependency declaration that does NOT inherit the workspace pin.
 *
 * `dep.workspace = true` and `dep = { workspace = true, features = [...] }` both
 * inherit; adding features on top of the workspace pin is the sanctioned way for
 * one crate to need more than the others, since the version still comes from one
 * place. Anything else carries its own version and can drift.
 */
export function pinsItsOwnVersion(declaration: string): boolean {
	return !/^\.workspace = true$/.test(declaration.trim()) && !/workspace\s*=\s*true/.test(declaration);
}
