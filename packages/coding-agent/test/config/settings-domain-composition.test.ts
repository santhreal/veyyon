/**
 * SETTINGS_SCHEMA is composed by spreading the settings-domains slices.
 * Unlike the former single object literal (where TypeScript hard-errors on a
 * duplicate key), a key defined in two domain files would silently last-write
 * win in the spread. This guard makes that collision a loud test failure.
 *
 * The slice list comes from `SETTINGS_DOMAIN_SLICES`, which sits beside the spread
 * itself. It used to be retyped here, and when the Agents domain was added the
 * copy was not updated: the guard kept passing while covering one slice less than
 * the schema actually had.
 *
 * The second rule is the load-order half of the same composition. The queries answer from a
 * registry the composer fills at import, so a module that reads a query from
 * `@veyyon/kernel/settings/schema` directly has no edge that loads the tables first: the exa search
 * provider read `getDefault` at module scope and threw with an empty registry in any graph the
 * composer had not reached yet. The composer re-exports every query, so a caller outside the kernel
 * imports it from there and the edge that answers is the edge that registers. Type-only imports are
 * erased and are not edges. What this does not catch: a graph in which the composer loads, but after
 * a module-scope read that runs earlier in the same graph; that is the cycle gate's subject.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { SETTINGS_DOMAIN_SLICES, SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { typeScriptMembers } from "../../../../scripts/workspace-layout";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const REGISTRY = "@veyyon/kernel/settings/schema";
const COMPOSER = "packages/coding-agent/src/config/settings-schema.ts";

async function tsFilesUnder(dir: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await tsFilesUnder(full)));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(full);
	}
	return found;
}

/** Every TypeScript file of every workspace member outside the kernel, plus the repository scripts, repo-relative. */
async function filesOutsideTheKernel(): Promise<string[]> {
	const found: string[] = [];
	for (const member of [...typeScriptMembers(), "scripts"]) {
		if (member === "kernel") continue;
		const dir = path.join(REPO_ROOT, member);
		if (!existsSync(dir)) continue;
		for (const file of await tsFilesUnder(dir)) found.push(path.relative(REPO_ROOT, file).replaceAll(path.sep, "/"));
	}
	return found;
}

describe("SETTINGS_SCHEMA domain composition", () => {
	it("no setting path is defined in two domain slices", () => {
		const owners = new Map<string, string>();
		const collisions: string[] = [];
		for (const [domain, slice] of Object.entries(SETTINGS_DOMAIN_SLICES)) {
			for (const path of Object.keys(slice)) {
				const owner = owners.get(path);
				if (owner) collisions.push(`${path} (in ${owner} and ${domain})`);
				owners.set(path, domain);
			}
		}
		expect(collisions).toEqual([]);
		// The spread lost nothing: the composed schema holds every domain key.
		expect(Object.keys(SETTINGS_SCHEMA).length).toBe(owners.size);
	});

	it("outside the kernel, only the composer reads the registry at run time", async () => {
		const files = await filesOutsideTheKernel();
		// The walk reached the trees it is asked about, so an empty result below is a finding and not
		// a broken walk.
		expect(files).toContain(COMPOSER);
		expect(files.some(file => file.startsWith("packages/coding-agent/test/"))).toBe(true);
		expect(files.some(file => file.startsWith("scripts/"))).toBe(true);
		expect(files.some(file => file.startsWith("tests/evals/"))).toBe(true);

		const readers: string[] = [];
		await Promise.all(
			files.map(async file => {
				const source = await readFile(path.join(REPO_ROOT, file), "utf8");
				if (source.includes(REGISTRY) && moduleSpecifiersIn(source).includes(REGISTRY)) {
					readers.push(file);
				}
			}),
		);
		expect(readers.sort()).toEqual([COMPOSER]);
	});
});
