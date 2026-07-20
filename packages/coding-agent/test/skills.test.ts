import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import "@veyyon/coding-agent/discovery";
import {
	loadSkills,
	loadSkillsFromDir,
	parseSkillInvocation,
	type Skill,
} from "@veyyon/coding-agent/extensibility/skills";
import { removeWithRetries } from "@veyyon/utils";
import { getAgentDir, setAgentDir } from "@veyyon/utils/dirs";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures/skills");
const collisionFixturesDir = path.resolve(import.meta.dirname, "fixtures/skills-collision");

const longSkillName = "this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard";
const expectedFixtureSkillOrder: string[] = [
	"bad--name",
	"different-name",
	"Invalid_Name",
	longSkillName,
	"unknown-field",
	"valid-skill",
];

/** Author a `SKILL.md` under `dir/<name>/`. */
async function writeSkill(dir: string, name: string, description: string, extraFrontmatter = ""): Promise<void> {
	const file = path.join(dir, name, "SKILL.md");
	await fs.mkdir(path.dirname(file), { recursive: true });
	const front = ["---", `name: ${name}`, `description: ${description}`, extraFrontmatter, "---"]
		.filter(line => line !== "")
		.join("\n");
	await fs.writeFile(file, `${front}\n\n# ${name}\n`);
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		const loadFixtureRoot = () => loadSkillsFromDir({ dir: fixturesDir, source: "test" });

		it("should load a valid skill from a skills root", async () => {
			const { skills, warnings } = await loadFixtureRoot();
			const validSkill = skills.find(skill => skill.name === "valid-skill");

			expect(validSkill).toBeDefined();
			expect(validSkill?.description).toBe("A valid skill for testing purposes.");
			expect(validSkill?.source).toBe("test");
			expect(warnings).toHaveLength(0);
		});

		it("should load skill when name doesn't match parent directory", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "different-name")).toBe(true);
		});

		it("should load skill with invalid name characters", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "Invalid_Name")).toBe(true);
		});

		it("should load skill when name exceeds 64 characters", async () => {
			const { skills } = await loadFixtureRoot();

			expect(
				skills.some(
					skill =>
						skill.name ===
						"this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard",
				),
			).toBe(true);
		});

		it("should skip skill when description is missing", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "missing-description")).toBe(false);
		});

		it("should load skill with unknown frontmatter fields", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "unknown-field")).toBe(true);
		});

		it("should not load nested skills recursively", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "child-skill")).toBe(false);
		});

		it("should skip files without frontmatter description", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "no-frontmatter")).toBe(false);
		});

		it("should load skill with consecutive hyphens in name", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "bad--name")).toBe(true);
		});

		it("should load all directly nested skills from fixture directory", async () => {
			const { skills } = await loadFixtureRoot();
			const names = skills.map(skill => skill.name);

			expect(names).toEqual(
				expect.arrayContaining([
					"valid-skill",
					"different-name",
					"Invalid_Name",
					"this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard",
					"unknown-field",
					"bad--name",
				]),
			);
			expect(names).not.toContain("child-skill");
			expect(skills).toHaveLength(6);
		});

		it("should return skills sorted by name (case-insensitive)", async () => {
			const { skills } = await loadFixtureRoot();
			const names = skills.map(skill => skill.name);

			expect(names).toEqual(expectedFixtureSkillOrder);
		});

		it("should return empty for non-existent directory", async () => {
			const { skills, warnings } = await loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});
			expect(skills).toHaveLength(0);
			expect(warnings).toHaveLength(0);
		});

		it("should return empty when scanning a single skill directory directly", async () => {
			const { skills } = await loadSkillsFromDir({
				dir: path.join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
		});
	});

	// Skills load ONLY from the active profile's agent dir
	// (`~/.veyyon/profiles/<name>/agent/skills`), plus its managed auto-learn
	// skills and profile-installed plugins. These tests point the agent dir at a
	// temp profile and prove that foreign-tool directories and project-local
	// `.veyyon/skills` never contribute skills, no matter what is on disk.
	describe("loadSkills profile scoping", () => {
		let tempHome: string;
		let tempCwd: string;
		let agentSkillsDir: string;
		let originalAgentDir: string;
		let homedirSpy: ReturnType<typeof spyOn>;

		beforeEach(async () => {
			originalAgentDir = getAgentDir();
			tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-skill-scope-home-"));
			// cwd lives under the fake home so any ancestor walk is bounded to it.
			tempCwd = path.join(tempHome, "work");
			await fs.mkdir(tempCwd, { recursive: true });
			homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
			const agentDir = path.join(tempHome, ".veyyon", "agent");
			setAgentDir(agentDir);
			agentSkillsDir = path.join(agentDir, "skills");
			await fs.mkdir(agentSkillsDir, { recursive: true });
		});

		afterEach(async () => {
			homedirSpy.mockRestore();
			setAgentDir(originalAgentDir);
			await removeWithRetries(tempHome);
		});

		it("loads authored skills from the active profile as native:user", async () => {
			await writeSkill(agentSkillsDir, "profile-skill", "A skill in the active profile.");
			const { skills } = await loadSkills({ cwd: tempCwd });
			const skill = skills.find(s => s.name === "profile-skill");
			expect(skill).toBeDefined();
			expect(skill?.source).toBe("native:user");
		});

		it("never loads foreign ~/.claude, ~/.codex, or ~/.agents skills", async () => {
			await writeSkill(agentSkillsDir, "profile-skill", "A skill in the active profile.");
			for (const [dir, name] of [
				[path.join(tempHome, ".claude", "skills"), "claude-skill"],
				[path.join(tempHome, ".codex", "skills"), "codex-skill"],
				[path.join(tempHome, ".agents", "skills"), "agents-skill"],
				[path.join(tempHome, ".agent", "skills"), "agent-skill"],
			] as const) {
				await writeSkill(dir, name, `Foreign ${name} that must never load.`);
			}

			const { skills } = await loadSkills({ cwd: tempCwd });
			const names = skills.map(s => s.name);
			expect(names).toContain("profile-skill");
			expect(names).not.toContain("claude-skill");
			expect(names).not.toContain("codex-skill");
			expect(names).not.toContain("agents-skill");
			expect(names).not.toContain("agent-skill");
			// Every loaded skill comes from a profile-native provider.
			expect(
				skills.every(s => ["native", "veyyon-managed", "veyyon-plugins"].includes(s.source.split(":")[0])),
			).toBe(true);
		});

		it("does not load project-local .veyyon/skills (no ambient project autodiscovery)", async () => {
			await writeSkill(agentSkillsDir, "profile-skill", "A skill in the active profile.");
			await writeSkill(
				path.join(tempCwd, ".veyyon", "skills"),
				"project-skill",
				"A project skill that must not load.",
			);

			const { skills } = await loadSkills({ cwd: tempCwd });
			const names = skills.map(s => s.name);
			expect(names).toContain("profile-skill");
			expect(names).not.toContain("project-skill");
		});

		it("returns no skills when the master switch is off", async () => {
			await writeSkill(agentSkillsDir, "profile-skill", "A skill in the active profile.");
			const { skills } = await loadSkills({ cwd: tempCwd, enabled: false });
			expect(skills).toHaveLength(0);
		});

		it("filters out ignoredSkills", async () => {
			await writeSkill(agentSkillsDir, "keep-me", "Kept.");
			await writeSkill(agentSkillsDir, "drop-me", "Dropped.");
			const { skills } = await loadSkills({ cwd: tempCwd, ignoredSkills: ["drop-me"] });
			const names = skills.map(s => s.name);
			expect(names).toContain("keep-me");
			expect(names).not.toContain("drop-me");
		});

		it("supports glob patterns in ignoredSkills", async () => {
			await writeSkill(agentSkillsDir, "valid-alpha", "Alpha.");
			await writeSkill(agentSkillsDir, "valid-beta", "Beta.");
			await writeSkill(agentSkillsDir, "other", "Other.");
			const { skills } = await loadSkills({ cwd: tempCwd, ignoredSkills: ["valid-*"] });
			const names = skills.map(s => s.name);
			expect(names).toEqual(["other"]);
		});

		it("filters to includeSkills glob patterns", async () => {
			await writeSkill(agentSkillsDir, "valid-alpha", "Alpha.");
			await writeSkill(agentSkillsDir, "valid-beta", "Beta.");
			await writeSkill(agentSkillsDir, "other", "Other.");
			const { skills } = await loadSkills({ cwd: tempCwd, includeSkills: ["valid-*"] });
			const names = skills.map(s => s.name).sort();
			expect(names).toEqual(["valid-alpha", "valid-beta"]);
		});

		it("lets ignoredSkills override includeSkills", async () => {
			await writeSkill(agentSkillsDir, "valid-alpha", "Alpha.");
			await writeSkill(agentSkillsDir, "valid-beta", "Beta.");
			const { skills } = await loadSkills({
				cwd: tempCwd,
				includeSkills: ["valid-*"],
				ignoredSkills: ["valid-alpha"],
			});
			expect(skills.map(s => s.name)).toEqual(["valid-beta"]);
		});

		it("skips skills disabled via frontmatter", async () => {
			await writeSkill(agentSkillsDir, "disabled-skill", "Should not be discovered.", "enabled: false");
			const { skills } = await loadSkills({ cwd: tempCwd });
			expect(skills.some(s => s.name === "disabled-skill")).toBe(false);
		});

		it("hides skills with disable-model-invocation frontmatter (Agent Skills spec)", async () => {
			await writeSkill(
				agentSkillsDir,
				"hidden-by-spec",
				"Hidden via the Agent Skills standard field.",
				"disable-model-invocation: true",
			);
			const { skills } = await loadSkills({ cwd: tempCwd });
			const skill = skills.find(s => s.name === "hidden-by-spec");
			expect(skill).toBeDefined();
			expect(skill?.hide).toBe(true);
		});

		it("discovers skills when the profile skills dir is a symlink", async () => {
			// Replace the real skills dir with a symlink to the shared fixtures.
			await removeWithRetries(agentSkillsDir);
			await fs.symlink(fixturesDir, agentSkillsDir, "dir");
			const { skills } = await loadSkills({ cwd: tempCwd });
			expect(skills.map(s => s.name)).toEqual(expectedFixtureSkillOrder);
			expect(skills.every(s => s.source === "native:user")).toBe(true);
		});
	});
});

describe("collision handling", () => {
	it("should detect name collisions and keep first skill", async () => {
		// Load from first directory
		const first = await loadSkillsFromDir({
			dir: path.join(collisionFixturesDir, "first"),
			source: "first",
		});

		const second = await loadSkillsFromDir({
			dir: path.join(collisionFixturesDir, "second"),
			source: "second",
		});

		// Both directories should have loaded one skill each
		expect(first.skills).toHaveLength(1);
		expect(second.skills).toHaveLength(1);

		// Both have the same name "calendar"
		expect(first.skills[0].name).toBe("calendar");
		expect(second.skills[0].name).toBe("calendar");

		// Simulate the collision behavior from loadSkills()
		const skillMap = new Map<string, Skill>();
		const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

		for (const skill of first.skills) {
			skillMap.set(skill.name, skill);
		}

		for (const skill of second.skills) {
			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionWarnings.push({
					skillPath: skill.filePath,
					message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
				});
			} else {
				skillMap.set(skill.name, skill);
			}
		}

		expect(skillMap.size).toBe(1);
		expect(skillMap.get("calendar")?.source).toBe("first");
		expect(collisionWarnings).toHaveLength(1);
		expect(collisionWarnings[0].message).toContain("name collision");
	});
});

describe("parseSkillInvocation", () => {
	describe("leading `/skill:<name>` form", () => {
		it("parses a bare leading command", () => {
			expect(parseSkillInvocation("/skill:foo")).toEqual({ name: "foo", args: "" });
		});

		it("captures everything after the first space as args", () => {
			expect(parseSkillInvocation("/skill:foo focus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
			});
		});

		it("allows leading whitespace before the `/skill:<name>` command", () => {
			expect(parseSkillInvocation("  /skill:foo focus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
			});
		});

		it("returns undefined for the bare `/skill:` prefix", () => {
			expect(parseSkillInvocation("/skill:")).toBeUndefined();
		});
	});

	describe("mid-prompt `/skill:<name>` form (issue #3913)", () => {
		it("threads surrounding prose through as args when the skill token appears after typed text", () => {
			expect(parseSkillInvocation("fix the auth bug /skill:security-scan ")).toEqual({
				name: "security-scan",
				args: "fix the auth bug",
			});
		});

		it("collapses prose on both sides of the skill token into a single args string", () => {
			expect(parseSkillInvocation("leading /skill:foo trailing")).toEqual({
				name: "foo",
				args: "leading trailing",
			});
		});

		it("preserves embedded newlines in args when the skill token spans a line break", () => {
			expect(parseSkillInvocation("explain this\nthen use /skill:security-scan ")).toEqual({
				name: "security-scan",
				args: "explain this\nthen use",
			});
		});

		it("does not hijack another slash command whose args mention a skill", () => {
			expect(parseSkillInvocation("/compact /skill:security-scan")).toBeUndefined();
			expect(parseSkillInvocation("/goal set /skill:foo focus on auth")).toBeUndefined();
		});

		it("does not hijack the bash tool (`!cmd`) when the body mentions a skill", () => {
			expect(parseSkillInvocation("!echo /skill:reviewer")).toBeUndefined();
			expect(parseSkillInvocation("!!echo /skill:reviewer")).toBeUndefined();
			expect(parseSkillInvocation("   !echo /skill:reviewer")).toBeUndefined();
		});

		it("does not hijack the python tool (`$ code`) when the body mentions a skill", () => {
			expect(parseSkillInvocation("$ run.py /skill:foo")).toBeUndefined();
			expect(parseSkillInvocation("$$ run.py /skill:foo")).toBeUndefined();
			expect(parseSkillInvocation("$\trun /skill:foo")).toBeUndefined();
		});

		it("still matches when `$` is followed by prose, not a python whitespace sigil", () => {
			// `$echo`, `${HOME}`, and `$200` are not python commands — `pythonCommandPrefixLength`
			// returns 0 for them — so the mid-prompt parser must still see the embedded skill.
			expect(parseSkillInvocation("$echo /skill:reviewer")).toEqual({
				name: "reviewer",
				args: "$echo",
			});
			// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal string containing shell variable
			expect(parseSkillInvocation("${HOME}/bin /skill:foo")).toEqual({
				name: "foo",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal string containing shell variable
				args: "${HOME}/bin",
			});
		});

		it("returns undefined when no `/skill:<name>` token is present", () => {
			expect(parseSkillInvocation("no skill token here")).toBeUndefined();
		});

		it("does not match when the slash is glued to a preceding non-whitespace character", () => {
			expect(parseSkillInvocation("https://example.com/skill:foo")).toBeUndefined();
		});

		it("excludes embedded slashes from the mid-prompt skill name", () => {
			// `/skill:foo/bar` mid-prompt is ambiguous with a path — the mid-prompt
			// regex requires `[^\s/]+`, so this falls through with no match.
			expect(parseSkillInvocation("see /skill:foo/bar")).toBeUndefined();
		});
	});
});
