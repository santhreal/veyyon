/**
 * How a member of this package is found: by being a file in the directory named
 * after its kind.
 *
 * Adding a bench is writing `benches/<id>.ts`. Adding a suite is writing
 * `suites/<id>.ts`, or `suites/<id>/main.ts` when it needs more than one file.
 * Same for a harness, a backend and a measurement. There is no index to append
 * to, no barrel to re-export through, no `builtinX` array to extend and no
 * registration call to remember, because each of those was a second place the set
 * of members was written down, and a second place is a place to forget.
 *
 * The directory states the kind and the file name states the id, so a member's
 * full identity is its path. That is the property this module exists to keep: a
 * reader who is handed a path knows what the file is, and a reader who wants the
 * set of members reads the directory.
 *
 * A member module states itself as its default export. Nothing else in the module
 * is read, so a member may export whatever else its own code needs.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Registry } from "./member-registry";

/** The one place a member kind is declared. A new kind is a row here and a directory. */
export interface MemberKind {
	/** Directory under the package root, and the plural noun a message calls the set. */
	readonly dir: string;
	/** What a caller is looking for, singular, for an error message. */
	readonly noun: string;
	/**
	 * What the module is.
	 *
	 * A `descriptor` states itself as a default-exported object the engine reads and
	 * calls. A `program` is a module run for its effect, printing a report; it has
	 * nothing to describe and is reached by path, so asking it for a default export
	 * would reject a correct file.
	 */
	readonly shape: "descriptor" | "program";
}

export const MEMBER_KINDS = {
	suite: { dir: "suites", noun: "suite", shape: "descriptor" },
	harness: { dir: "harnesses", noun: "harness", shape: "descriptor" },
	backend: { dir: "backends", noun: "backend", shape: "descriptor" },
	bench: { dir: "benches", noun: "bench", shape: "program" },
	measurement: { dir: "measurements", noun: "measurement", shape: "program" },
	tool: { dir: "tools", noun: "tool", shape: "program" },
} as const satisfies Record<string, MemberKind>;

export type MemberKindName = keyof typeof MEMBER_KINDS;

/** A kind whose members are read as a default-exported descriptor. */
export type DescriptorKindName = {
	[K in MemberKindName]: (typeof MEMBER_KINDS)[K]["shape"] extends "descriptor" ? K : never;
}[MemberKindName];

/** The module a directory member is entered through. */
const DIRECTORY_ENTRY = "main.ts";

/** The package root, which is the parent of this `engine/` directory. */
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

/** A discovered member file, before it is imported. */
export interface MemberSource {
	readonly id: string;
	readonly modulePath: string;
}

/**
 * Every member file of one kind, sorted by id.
 *
 * A `.ts` file is a member and its name without the extension is its id. A
 * directory is a member when it holds `main.ts`, and its own name is the id. A
 * name starting with `_` is skipped, which is how a directory keeps a shared file
 * beside its members without that file becoming one.
 *
 * A missing directory yields no members rather than throwing: a checkout that
 * carries no measurements is a checkout with no measurements, not a broken one.
 */
export async function findMembers(kind: MemberKindName, root: string = PACKAGE_ROOT): Promise<readonly MemberSource[]> {
	const dir = path.join(root, MEMBER_KINDS[kind].dir);
	let entries: readonly Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const found: MemberSource[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) {
			const entryModule = path.join(dir, entry.name, DIRECTORY_ENTRY);
			if (await isFile(entryModule)) found.push({ id: entry.name, modulePath: entryModule });
			continue;
		}
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
		found.push({ id: entry.name.slice(0, -".ts".length), modulePath: path.join(dir, entry.name) });
	}
	return found.sort((left, right) => left.id.localeCompare(right.id));
}

async function isFile(target: string): Promise<boolean> {
	try {
		return (await fs.stat(target)).isFile();
	} catch {
		return false;
	}
}

/**
 * Imports every member of one kind and returns them registered under the id its
 * path states.
 *
 * A member module that exports no default, or whose default is not an object, is
 * rejected naming its own path: the alternative is a member that is silently
 * absent, which is the failure mode explicit registration was supposed to prevent
 * and did not, because a forgotten index line is silent too.
 *
 * The path is the one authority for the id, enforced by rejecting a descriptor
 * whose own `id` disagrees with its file name. The descriptor is registered as it
 * was exported; copying it into a fresh object would drop the methods of a class
 * instance, which is what most of these are.
 */
export async function loadMembers<T extends { id: string }>(
	kind: DescriptorKindName,
	root: string = PACKAGE_ROOT,
): Promise<Registry<T>> {
	const registry = new Registry<T>(MEMBER_KINDS[kind].noun);
	for (const source of await findMembers(kind, root)) {
		// The specifier is a path discovered at run time, which is what a dynamic
		// import is for; there is no static spelling of "every file in a directory".
		const loaded: unknown = await import(source.modulePath);
		const descriptor = (loaded as { default?: unknown }).default;
		const relative = path.relative(root, source.modulePath);
		if (descriptor === undefined || descriptor === null || typeof descriptor !== "object") {
			throw new Error(
				`${relative} is in ${MEMBER_KINDS[kind].dir}/ but exports no default ${
					MEMBER_KINDS[kind].noun
				}. A member states itself as its default export.`,
			);
		}
		const declared = (descriptor as { id?: unknown }).id;
		if (declared !== source.id) {
			throw new Error(
				`${relative} declares id ${JSON.stringify(declared)} but its path states ${JSON.stringify(source.id)}. ` +
					`Rename the file or the id so a reader handed either one knows the other.`,
			);
		}
		registry.register(descriptor as T);
	}
	return registry;
}
