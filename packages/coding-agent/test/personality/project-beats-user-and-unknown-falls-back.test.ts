/**
 * system-prompt-personality.test.ts already pins default.md override, unknown
 * fallback-with-warning, and `none` omitting the block. Remaining misses:
 *
 *   - a project spec beats a *user* spec of the same name (not only default.md)
 *   - `none` still short-circuits when project/user default.md exist
 *   - catalog is case-sensitive: Friendly.md is not the built-in friendly
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	NONE_PERSONALITY,
	resolveAvailablePersonalities,
	resolvePersonality,
} from "@veyyon/coding-agent/personality/resolver";
import { useTempHome } from "../helpers/temp-home";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeProject = useTrackedTempDirs("pi-personality-prec-");
const tempHome = useTempHome("test");

function writeProject(cwd: string, name: string, body: string): void {
	const dir = path.join(cwd, ".veyyon", "personalities");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), body);
}

function writeUser(name: string, body: string): void {
	const dir = path.join(tempHome(), ".veyyon", "personalities");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), body);
}

describe("project beats user of the same name", () => {
	it("lets a project terse.md beat a user terse.md", async () => {
		const cwd = makeProject();
		writeUser("terse.md", "USER TONE must not appear in the wrapper");
		writeProject(cwd, "terse.md", "PROJECT TONE is the one the repo chose");
		const resolved = await resolvePersonality("terse", { cwd });
		expect(resolved.text).toContain("PROJECT TONE");
		expect(resolved.text).not.toContain("USER TONE");
	});

	it("does not read default.md when the request is the none sentinel", async () => {
		const cwd = makeProject();
		writeProject(cwd, "default.md", "PROJECT DEFAULT must not leak into none");
		writeUser("default.md", "USER DEFAULT must not leak into none");
		const resolved = await resolvePersonality(NONE_PERSONALITY, { cwd });
		expect(resolved.name).toBe(NONE_PERSONALITY);
		expect(resolved.text).toBe("");
	});

	it("treats Friendly.md as a distinct catalog name from the built-in friendly", async () => {
		const cwd = makeProject();
		writeProject(cwd, "Friendly.md", "TITLE CASE friendly is a different catalog entry");
		const names = await resolveAvailablePersonalities({ cwd });
		expect(names).toContain("friendly");
		expect(names).toContain("Friendly");
		const titled = await resolvePersonality("Friendly", { cwd });
		expect(titled.text).toContain("TITLE CASE");
		const builtin = await resolvePersonality("friendly", { cwd });
		expect(builtin.text).not.toContain("TITLE CASE");
	});
});
