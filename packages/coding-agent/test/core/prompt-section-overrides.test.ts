/**
 * SYSPROMPT-4: changing one prompt section must not mean forking the whole prompt.
 *
 * There were three ways to influence the system prompt and none of them was a
 * supported per-section edit. `--system-prompt`/`SYSTEM.md` replaces all 272
 * lines of the template, taking every section you wanted to keep and every
 * settings-gated branch inside them; `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` does
 * the right thing but is an eval instrument, deliberately unreachable from
 * config so no `config.yml` can quietly swap a section; and `promptSectionOrder`
 * can only reorder. So adding one rule to the delivery contract meant forking
 * the prompt and then falling behind it.
 *
 * `PROMPT_SECTIONS/` closes that, and these suites hold it to the two
 * properties that make it safe rather than merely convenient:
 *
 *   - CONTAINMENT. Overriding one section leaves every other section, and every
 *     conditional inside them, byte-identical to the shipped template. Without
 *     that, a per-section override is just a smaller fork.
 *   - LOUDNESS. A file naming a section that does not exist is a typo whose
 *     symptom is silence: the operator believes their change is live while the
 *     shipped prompt runs unmodified. That must throw, not be skipped.
 *
 * Append gets the most attention because it is the mode that survives upgrades:
 * the shipped section stays exactly as shipped, including text added to it
 * later, and the addition follows it.
 */
import { describe, expect, it } from "bun:test";
import {
	assembleDefaultTemplate,
	DEFAULT_TEMPLATE_SECTIONS,
} from "@veyyon/coding-agent/system-prompt-builder/default-template";
import {
	applySectionOverrides,
	assertKnownSectionId,
	loadSectionOverrideFiles,
	parseSectionOverrideFilename,
	type SectionOverrideFile,
} from "@veyyon/coding-agent/system-prompt-builder/section-overrides";

function file(
	id: string,
	mode: "replace" | "append",
	content: string,
	level: "user" | "project" = "project",
): SectionOverrideFile {
	return { id, mode, content, level, path: `/fake/${PROMPT_DIR}/${id}${mode === "append" ? ".append" : ""}.md` };
}
const PROMPT_DIR = "PROMPT_SECTIONS";

describe("reading a filename as a section and a mode", () => {
	it("reads a plain .md as a replacement", () => {
		expect(parseSectionOverrideFilename("role.md")).toEqual({ id: "role", mode: "replace" });
	});

	it("reads .append.md as an addition", () => {
		// The suffix has to win over the plain `.md` match, since every append file
		// also ends in `.md`. Getting this backwards would treat every append as a
		// replacement and silently delete the shipped section.
		expect(parseSectionOverrideFilename("delivery-contract.append.md")).toEqual({
			id: "delivery-contract",
			mode: "append",
		});
	});

	it("keeps hyphenated section ids intact", () => {
		// The registry ids are kebab-case and that is what `--sections` prints, so
		// the filename a user copies from it has to work verbatim.
		expect(parseSectionOverrideFilename("execution-workflow.md")?.id).toBe("execution-workflow");
	});

	it("ignores a file that is not markdown", () => {
		// A README, an editor swapfile or a `.DS_Store` in the directory is not an
		// attempted override and must not be an error.
		expect(parseSectionOverrideFilename("README.txt")).toBeNull();
		expect(parseSectionOverrideFilename(".role.md.swp")).toBeNull();
	});
});

describe("an unknown section name is refused", () => {
	it("throws, naming the file and every valid section", () => {
		// The silent-failure case. Skipping it would leave the operator believing a
		// change is live while the shipped prompt runs untouched, which is the same
		// false confidence the eval override's validation exists to prevent.
		expect(() => assertKnownSectionId("delivery_contract", "delivery_contract.md")).toThrow(
			/unknown prompt section "delivery_contract"/,
		);
	});

	it("lists the valid ids so the fix is visible in the message", () => {
		try {
			assertKnownSectionId("rolez", "rolez.md");
			throw new Error("expected an unknown section id to throw");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("role");
			expect(message).toContain("tool-policy");
			expect(message).toContain("veyyon prompt --sections");
		}
	});

	it("accepts every id the registry declares", () => {
		// The differential: a check that rejected everything would satisfy the
		// tests above and break the feature entirely.
		for (const id of ["conventions", "role", "runtime", "tool-policy", "execution-workflow", "delivery-contract"]) {
			expect(() => assertKnownSectionId(id, `${id}.md`)).not.toThrow();
		}
	});
});

describe("appending to a section", () => {
	const overrides = applySectionOverrides([file("role", "append", "Always answer in French.")]);

	it("keeps the shipped section text ahead of the addition", () => {
		// The property that makes append upgrade-safe. The shipped text is reused,
		// not restated, so a line added to ROLE next release is still there.
		expect(overrides.role).toContain(DEFAULT_TEMPLATE_SECTIONS.role.trim());
		expect(overrides.role).toContain("Always answer in French.");
		expect(overrides.role?.indexOf("Always answer in French.")).toBeGreaterThan(0);
	});

	it("separates the addition with exactly one blank line", () => {
		// The shipped sections end in varying numbers of newlines, so joining
		// naively opens a ragged gap in the middle of the prompt.
		expect(overrides.role).toContain("\n\nAlways answer in French.");
		expect(overrides.role).not.toMatch(/\n{3,}Always answer/);
	});

	it("preserves the section's trailing whitespace, which separates it from the next banner", () => {
		// The addition goes INSIDE the section. Normalizing the trailing run away,
		// or appending after it, moves the boundary to the next section and so
		// changes the document outside the overridden region — the exact
		// containment failure a per-section override must not have.
		const trailing = /\s*$/.exec(DEFAULT_TEMPLATE_SECTIONS.role)?.[0] ?? "";

		expect(overrides.role?.endsWith(trailing)).toBe(true);
	});

	it("requires no banner, because the section it follows already has one", () => {
		// Demanding a banner on an append would emit a duplicate heading, and
		// duplicate banners are what the splitter keys off.
		expect(overrides.role?.startsWith("ROLE")).toBe(true);
		expect(overrides.role?.match(/^ROLE$/gm)).toHaveLength(1);
	});

	it("leaves every other section untouched", () => {
		// CONTAINMENT. Without this a per-section override is just a smaller fork.
		expect(Object.keys(overrides)).toEqual(["role"]);
	});
});

describe("replacing a section", () => {
	it("requires the section's banner", () => {
		// A replacement without its banner collapses two sections into one on the
		// next split, and a later override then targets the wrong region.
		expect(() => applySectionOverrides([file("role", "replace", "You are a pirate.")])).toThrow(/banner/);
	});

	it("accepts a replacement that keeps the banner", () => {
		const overrides = applySectionOverrides([file("role", "replace", "ROLE\n====\nYou are a pirate.")]);

		expect(overrides.role).toBe("ROLE\n====\nYou are a pirate.");
	});

	/**
	 * The underline is part of the banner, and the check has to agree with the
	 * SPLITTER about how much of it is required.
	 *
	 * These fixtures used to write `ROLE\n==`, and it was accepted, because the
	 * check was `startsWith(banner)` against a registry field that itself ended in
	 * two `=`. The splitter needs four to cut on, so the accepted override produced
	 * a prompt whose ROLE section no longer opened a region: `veyyon prompt
	 * --sections` stopped seeing it, `promptSectionOrder` could not move it, and a
	 * later override for another section addressed the wrong span. Nothing failed
	 * anywhere — the text was in the prompt, just no longer a section.
	 */
	it("refuses an underline too short for the splitter to cut on", () => {
		expect(() => applySectionOverrides([file("role", "replace", "ROLE\n==\nYou are a pirate.")])).toThrow(
			/must begin with its section banner: "ROLE"/,
		);
	});

	/**
	 * And it has to say HOW LONG, because the user's next action is to edit that file.
	 * The message used to end at the banner name, so a file refused for its underline
	 * read as though the name were wrong; the width came from prose written by hand at
	 * the throw site, which nothing compared against the check.
	 */
	it("tells the user the width the underline needs", () => {
		expect(() => applySectionOverrides([file("role", "replace", "ROLE\n==\nYou are a pirate.")])).toThrow(
			/at least 4 "=" characters/,
		);
	});

	/** Wider than the shipped 14 is fine: a hand-written file is underlined by eye. */
	it("accepts an underline longer than the one the template ships", () => {
		const long = `ROLE\n${"=".repeat(60)}\nYou are a pirate.`;

		expect(applySectionOverrides([file("role", "replace", long)]).role).toBe(long);
	});

	it("composes with an append for the same section", () => {
		// Refusing the combination would make the two mechanisms mutually
		// exclusive for no reason: the replacement supplies the section, the
		// append follows it.
		const overrides = applySectionOverrides([
			file("role", "replace", "ROLE\n====\nYou are a pirate."),
			file("role", "append", "Never break character."),
		]);

		expect(overrides.role).toBe("ROLE\n====\nYou are a pirate.\n\nNever break character.");
	});
});

describe("precedence between the user and project levels", () => {
	it("lets a project file win over a user file for the same section and mode", () => {
		// A repository has to be able to override a personal default without
		// restating the ones it does not care about.
		const overrides = applySectionOverrides([
			file("role", "append", "user text", "user"),
			file("role", "append", "project text", "project"),
		]);

		expect(overrides.role).toContain("project text");
		expect(overrides.role).not.toContain("user text");
	});

	it("does not let file order decide the winner", () => {
		// Discovery order is an implementation detail of directory listing; if it
		// decided precedence the result would vary by filesystem.
		const overrides = applySectionOverrides([
			file("role", "append", "project text", "project"),
			file("role", "append", "user text", "user"),
		]);

		expect(overrides.role).toContain("project text");
	});

	it("keeps a user override for a section the project does not touch", () => {
		// Precedence is per section, not whole-directory: a project file for ROLE
		// must not silently discard a user file for RUNTIME.
		const overrides = applySectionOverrides([
			file("runtime", "append", "user runtime", "user"),
			file("role", "append", "project role", "project"),
		]);

		expect(overrides.runtime).toContain("user runtime");
		expect(overrides.role).toContain("project role");
	});
});

describe("the assembled template", () => {
	it("is byte-identical to the shipped one when nothing is overridden", () => {
		// The baseline that makes every assertion above meaningful: overrides are
		// the only thing that can change the prompt.
		expect(assembleDefaultTemplate(applySectionOverrides([]))).toBe(assembleDefaultTemplate());
	});

	it("changes only the overridden region", () => {
		// Measured on the assembled document rather than on the override map,
		// because the map being right does not prove the assembly used it right.
		const before = assembleDefaultTemplate();
		const after = assembleDefaultTemplate(applySectionOverrides([file("role", "append", "EXTRA LINE")]));

		expect(after).toContain("EXTRA LINE");
		expect(after.replace("\n\nEXTRA LINE", "")).toBe(before);
	});
});

describe("discovering override files on disk", () => {
	/**
	 * `loadSectionOverrideFiles` walks two real directories, so the tests above
	 * (which construct file records directly) prove the folding logic and nothing
	 * about whether the files are ever found. The reader is injected here rather
	 * than writing to the user's real agent directory, which a test must never
	 * touch.
	 */
	function fakeFs(tree: Record<string, Record<string, string>>) {
		return {
			listDir: async (dir: string) => Object.keys(tree[dir] ?? {}),
			readFile: async (file: string) => {
				const dir = file.slice(0, file.lastIndexOf("/"));
				const name = file.slice(file.lastIndexOf("/") + 1);
				const content = tree[dir]?.[name];
				// The reader throws rather than answering with a sentinel, matching the
				// real one: a file the listing just named cannot be quietly skipped.
				if (content === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
				return content;
			},
		};
	}

	it("finds an append file in the project config directory", async () => {
		const projectDir = "/repo/.veyyon";
		const files = await loadSectionOverrideFiles({
			cwd: "/repo",
			projectConfigDir: projectDir,
			...fakeFs({ [`${projectDir}/${PROMPT_DIR}`]: { "role.append.md": "extra rule" } }),
		});

		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ id: "role", mode: "append", level: "project", content: "extra rule" });
	});

	it("returns nothing when the directory does not exist", async () => {
		// The overwhelmingly common case: almost nobody overrides a section. A
		// missing directory is absence, not failure, and must not throw or warn.
		const files = await loadSectionOverrideFiles({ cwd: "/repo", ...fakeFs({}) });

		expect(files).toEqual([]);
	});

	/**
	 * A directory that exists and cannot be read is NOT the same fact as one that is
	 * not there, and the loader used to answer both with an empty list.
	 *
	 * The failure it caused is total and silent: a `PROMPT_SECTIONS` the process
	 * cannot open (root-owned after a `sudo` edit, a broken symlink, a path that is a
	 * file) drops every override the user wrote, and the agent runs the shipped prompt
	 * with nothing logged. That is the exact false confidence this module's own header
	 * says it exists to prevent, so it is refused rather than reported (Law 10).
	 */
	it("refuses a directory that exists but cannot be read", async () => {
		const denied = async () => {
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		};

		await expect(loadSectionOverrideFiles({ cwd: "/repo", listDir: denied })).rejects.toThrow(
			/cannot read .*PROMPT_SECTIONS.*permission denied/,
		);
	});

	/**
	 * And the message has to say what the consequence would have been, because the
	 * symptom the user would otherwise chase is "my override stopped working" with no
	 * connection to a permission bit.
	 */
	it("says the overrides would not have been applied", async () => {
		const denied = async () => {
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		};

		await expect(loadSectionOverrideFiles({ cwd: "/repo", listDir: denied })).rejects.toThrow(/would not be applied/);
	});

	/**
	 * The other half of the split. `ENOTDIR` means a component of the path is not a
	 * directory, so nothing can exist below it — the same fact as `ENOENT` reached
	 * differently, and `isMissingPath` owns that judgement rather than this loader
	 * deciding it again.
	 */
	it("treats ENOTDIR as absence, like a missing directory", async () => {
		const notADir = async () => {
			throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
		};

		expect(await loadSectionOverrideFiles({ cwd: "/repo", listDir: notADir })).toEqual([]);
	});

	/**
	 * A file the LISTING just named is a different case from a missing directory: it
	 * exists, it was written to change the prompt, and skipping it left the operator
	 * with a file on disk that had quietly stopped doing anything. The reader used to
	 * answer any failure with `null` and the loop dropped it without a word.
	 */
	it("refuses a listed file it cannot read", async () => {
		const projectDir = "/repo/.veyyon";

		await expect(
			loadSectionOverrideFiles({
				cwd: "/repo",
				projectConfigDir: projectDir,
				listDir: async (dir: string) => (dir.includes(".veyyon") ? ["role.append.md"] : []),
				readFile: async () => {
					throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
				},
			}),
		).rejects.toThrow(/cannot read prompt section override .*role\.append\.md.*permission denied/);
	});

	it("throws on a markdown file naming a section that does not exist", async () => {
		// The discovery half of the loudness contract. A typo here is silent by
		// nature: the file sits there looking applied while the shipped prompt runs.
		const projectDir = "/repo/.veyyon";

		await expect(
			loadSectionOverrideFiles({
				cwd: "/repo",
				projectConfigDir: projectDir,
				...fakeFs({ [`${projectDir}/${PROMPT_DIR}`]: { "delivery_contract.md": "x" } }),
			}),
		).rejects.toThrow(/unknown prompt section/);
	});

	it("ignores non-markdown files sitting in the directory", async () => {
		const projectDir = "/repo/.veyyon";
		const files = await loadSectionOverrideFiles({
			cwd: "/repo",
			projectConfigDir: projectDir,
			...fakeFs({ [`${projectDir}/${PROMPT_DIR}`]: { "README.txt": "notes", "role.append.md": "rule" } }),
		});

		expect(files.map(f => f.id)).toEqual(["role"]);
	});

	it("labels project and user files by level so precedence can be applied", async () => {
		// Level is what `applySectionOverrides` resolves precedence on, so a loader
		// that mislabelled it would silently invert project-over-user.
		const projectDir = "/repo/.veyyon";
		const files = await loadSectionOverrideFiles({
			cwd: "/repo",
			projectConfigDir: projectDir,
			...fakeFs({ [`${projectDir}/${PROMPT_DIR}`]: { "role.append.md": "project rule" } }),
		});

		expect(files[0]?.level).toBe("project");
	});
});
