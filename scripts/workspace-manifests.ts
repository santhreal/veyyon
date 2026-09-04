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
import { rustMembers } from "./workspace-layout";

/** The repository root, found from this file rather than the process cwd. */
export const repoRoot = path.resolve(import.meta.dir, "..");

/** One crate manifest, as much of it as the contract needs. */
export interface CrateManifest {
	/** Path from the repository root to the crate directory. */
	dir: string;
	/** The `name` field, which is what `cargo -p` resolves. */
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

/** Read one crate manifest by its path from the repository root. */
export function readCrateManifest(dir: string): CrateManifest {
	const text = fs.readFileSync(path.join(repoRoot, dir, "Cargo.toml"), "utf8");
	return {
		dir,
		name: packageField(text, "name").replace(/"/g, ""),
		version: packageField(text, "version"),
		dependencies: dependencyLines(text),
	};
}

/**
 * Every first-party crate directory, resolved from the root `Cargo.toml` member list.
 *
 * The vendored tree is deliberately excluded: those are read-only snapshots of upstream crates held
 * to upstream's conventions, and rewriting their manifests to inherit ours would be an edit to
 * vendored code.
 *
 * WHY IT IS RESOLVED RATHER THAN LISTED. This read one directory (`crates/`) and returned its
 * subdirectory names. The Rust tree is now grouped by purpose under `natives/`, so a crate sits at
 * `natives/search/glob` and a one-level listing returns the group directories: every manifest
 * assertion in this suite would then read a `Cargo.toml` that does not exist, or find no crates at
 * all and pass. `rustMembers()` returns what cargo itself resolves, at whatever depth.
 */
export function firstPartyCrateDirs(): string[] {
	return rustMembers().filter(directory => !directory.split("/").includes("vendor"));
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
