/**
 * A package relocation left `gen:tool-views` pointing at a removed directory.
 * Sweep the root and every declared workspace member for literal --cwd arguments;
 * each must resolve from its declaring package to an existing directory. Unknown
 * or dynamic arguments fail rather than silently escaping the sweep.
 * This does not validate shell `cd`, script bodies, or external executables.
 */
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, typeScriptMembers } from "./workspace-layout";

test("package script working directories survive workspace relocations", () => {
	const invalid: string[] = [];
	for (const member of [".", ...typeScriptMembers()]) {
		const manifest: { scripts?: Record<string, string> } = JSON.parse(
			readFileSync(join(REPO_ROOT, member, "package.json"), "utf8"),
		);
		for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
			const flags = [...command.matchAll(/--cwd\b/gu)];
			const arguments_ = [
				...command.matchAll(/--cwd(?:=|\s+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|"'`]+))(?=$|[\s;&|])/gu),
			];
			if (flags.length !== arguments_.length) {
				invalid.push(`${member}:${name}: unrecognized --cwd argument`);
				continue;
			}
			for (const argument of arguments_) {
				const directory = argument[1] ?? argument[2] ?? argument[3];
				if (!directory || /[$`~]/u.test(directory)) {
					invalid.push(`${member}:${name}: nonliteral --cwd argument`);
					continue;
				}
				try {
					if (statSync(resolve(REPO_ROOT, member, directory)).isDirectory()) continue;
				} catch {
					// Report every invalid reference together, including inaccessible paths.
				}
				invalid.push(`${member}:${name}: --cwd=${directory} is not a directory`);
			}
		}
	}
	expect(invalid).toEqual([]);
});
