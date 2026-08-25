/**
 * Personality resolution is project > user > built-in, `none` is an exact
 * sentinel, and an unknown name MUST fall back to default with a warning
 * rather than injecting an empty block.
 *
 * WHY THIS SUITE EXISTS. The tag-breakout suite pins wrapper-escape forms and
 * `None.md` not shadowing the sentinel. It does not pin:
 *
 *   - a project file beating a user file of the same name
 *   - a user file beating the built-in of the same name
 *   - an unknown name listing available names (including `none`) in the warning
 *   - `none` short-circuiting without reading disk (a project `default.md`
 *     must not leak into a `none` request)
 *   - catalog case: `Friendly.md` is not the built-in `friendly`
 *   - `resolveAvailablePersonalities` excludes `none` even when a file tries
 *
 * Empty-for-unknown is the silent-personality defect: the operator asked for
 * a tone and got the unadorned default prompt with no warning.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_PERSONALITY_NAME,
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

describe("precedence is project, then user, then built-in", () => {
	it("lets a project spec beat a user spec of the same name", async () => {
		const cwd = makeProject();
		writeUser("terse.md", "USER TONE must not appear in the wrapper");
		writeProject(cwd, "terse.md", "PROJECT TONE is the one the repo chose");
		const resolved = await resolvePersonality("terse", { cwd });
		expect(resolved.name).toBe("terse");
		expect(resolved.text).toContain("PROJECT TONE");
		expect(resolved.text).not.toContain("USER TONE");
		expect(resolved.warning).toBeUndefined();
	});

	it("lets a user spec beat the built-in of the same name", async () => {
		const cwd = makeProject();
		writeUser("default.md", "USER DEFAULT overrides the bundled default tone");
		const resolved = await resolvePersonality("default", { cwd });
		expect(resolved.name).toBe("default");
		expect(resolved.text).toContain("USER DEFAULT");
		expect(resolved.text).not.toContain("Terse, evidence-first");
	});

	it("falls through a missing project file to the user file", async () => {
		const cwd = makeProject();
		writeUser("terse.md", "USER TONE when the project has no terse.md");
		const resolved = await resolvePersonality("terse", { cwd });
		expect(resolved.text).toContain("USER TONE");
	});

	it("falls through missing project and user files to the built-in default", async () => {
		const cwd = makeProject();
		const resolved = await resolvePersonality("default", { cwd });
		expect(resolved.name).toBe("default");
		expect(resolved.text.trim().length).toBeGreaterThan(0);
		expect(resolved.warning).toBeUndefined();
	});
});

describe("none is an exact sentinel and does not read disk", () => {
	it("returns an empty block for none even when project default.md exists", async () => {
		const cwd = makeProject();
		writeProject(cwd, "default.md", "PROJECT DEFAULT must not leak into none");
		writeUser("default.md", "USER DEFAULT must not leak into none");
		const resolved = await resolvePersonality(NONE_PERSONALITY, { cwd });
		expect(resolved.name).toBe(NONE_PERSONALITY);
		expect(resolved.text).toBe("");
		expect(resolved.warning).toBeUndefined();
	});

	it("does not treat the string 'None' as the sentinel (exact match only)", async () => {
		const cwd = makeProject();
		const resolved = await resolvePersonality("None", { cwd });
		expect(resolved.name).toBe(DEFAULT_PERSONALITY_NAME);
		expect(resolved.warning).toMatch(/Unknown personality "None"/);
		expect(resolved.text.trim().length).toBeGreaterThan(0);
	});
});

describe("unknown names fall back to default WITH a warning that lists available names", () => {
	it("falls back to default and names the request in the warning", async () => {
		const cwd = makeProject();
		const resolved = await resolvePersonality("pirate", { cwd });
		expect(resolved.name).toBe(DEFAULT_PERSONALITY_NAME);
		expect(resolved.warning).toMatch(/Unknown personality "pirate"/);
		expect(resolved.warning).toMatch(new RegExp(`falling back to "${DEFAULT_PERSONALITY_NAME}"`));
		expect(resolved.warning).toContain(NONE_PERSONALITY);
		expect(resolved.warning).toContain("default");
		expect(resolved.warning).toContain("friendly");
		expect(resolved.warning).toContain("pragmatic");
		expect(resolved.text.trim().length).toBeGreaterThan(0);
	});

	it("includes project-only names in the available list of an unknown-name warning", async () => {
		const cwd = makeProject();
		writeProject(cwd, "terse.md", "project terse tone for this repo only");
		const resolved = await resolvePersonality("missing", { cwd });
		expect(resolved.warning).toContain("terse");
	});

	it("does not emit an empty text for an unknown name", async () => {
		const cwd = makeProject();
		const resolved = await resolvePersonality("no-such-tone", { cwd });
		expect(resolved.text).not.toBe("");
	});
});

describe("the catalog does not include the none sentinel", () => {
	it("lists built-ins and project/user names, never none", async () => {
		const cwd = makeProject();
		writeProject(cwd, "terse.md", "project terse");
		writeUser("warm.md", "user warm");
		const names = await resolveAvailablePersonalities({ cwd });
		expect(names).toContain("default");
		expect(names).toContain("friendly");
		expect(names).toContain("pragmatic");
		expect(names).toContain("terse");
		expect(names).toContain("warm");
		expect(names).not.toContain("none");
		expect(names).not.toContain("None");
	});

	it("does not list None.md as a selectable name", async () => {
		const cwd = makeProject();
		writeProject(cwd, "None.md", "this file must not become a personality named none");
		const names = await resolveAvailablePersonalities({ cwd });
		expect(names).not.toContain("none");
		expect(names).not.toContain("None");
	});

	it("treats Friendly.md as a distinct name from the built-in friendly", async () => {
		const cwd = makeProject();
		writeProject(cwd, "Friendly.md", "TITLE CASE friendly is a different catalog entry");
		const names = await resolveAvailablePersonalities({ cwd });
		expect(names).toContain("friendly");
		expect(names).toContain("Friendly");
		const titled = await resolvePersonality("Friendly", { cwd });
		expect(titled.name).toBe("Friendly");
		expect(titled.text).toContain("TITLE CASE");
		const builtin = await resolvePersonality("friendly", { cwd });
		expect(builtin.name).toBe("friendly");
		expect(builtin.text).not.toContain("TITLE CASE");
	});
});
