/**
 * Behavioral coverage for persistent per-section prompt customization.
 *
 * Override files contain section bodies only. The section registry owns names,
 * order, and banners, while the statement registry supplies the shipped base.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	assembleDefaultTemplate,
	assembleStatementSections,
} from "@veyyon/coding-agent/system-prompt-builder/default-template";
import {
	applySectionOverrides,
	assertKnownSectionId,
	loadSectionOverrideFiles,
	parseSectionOverrideFilename,
	type SectionOverrideFile,
} from "@veyyon/coding-agent/system-prompt-builder/section-overrides";
import { STATEMENT_SECTIONS } from "@veyyon/coding-agent/system-prompt-builder/statement-registry";
import { getAgentDir } from "@veyyon/utils";

const PROMPT_DIR = "PROMPT_SECTIONS";
const SHIPPED = assembleStatementSections({ renderMermaid: true });

/** The one directory overrides are discovered in: the active profile's. */
const OPERATOR_DIR = path.join(getAgentDir(), PROMPT_DIR);

function file(id: string, mode: "replace" | "append", content: string): SectionOverrideFile {
	return { id, mode, content, path: `/fake/${PROMPT_DIR}/${id}${mode === "append" ? ".append" : ""}.md` };
}

describe("reading a filename as a section and mode", () => {
	/** A plain Markdown file replaces the named section body. */
	it("reads a plain .md as a replacement", () => {
		expect(parseSectionOverrideFilename("role.md")).toEqual({ id: "role", mode: "replace" });
	});

	/** The longer append suffix must win over the plain Markdown suffix. */
	it("reads .append.md as an addition", () => {
		expect(parseSectionOverrideFilename("delivery-contract.append.md")).toEqual({
			id: "delivery-contract",
			mode: "append",
		});
	});

	/** Public section ids are kebab-case and must survive filename parsing. */
	it("keeps hyphenated section ids intact", () => {
		expect(parseSectionOverrideFilename("execution-workflow.md")?.id).toBe("execution-workflow");
	});

	/** Non-Markdown directory entries are not attempted prompt overrides. */
	it("ignores files that are not markdown", () => {
		expect(parseSectionOverrideFilename("README.txt")).toBeNull();
		expect(parseSectionOverrideFilename(".role.md.swp")).toBeNull();
	});
});

describe("unknown section names fail loudly", () => {
	/** A typo must name the invalid section instead of running without it. */
	it("names the unknown section", () => {
		expect(() => assertKnownSectionId("delivery_contract", "delivery_contract.md")).toThrow(
			/unknown prompt section "delivery_contract"/,
		);
	});

	/** The error must provide valid ids and the command that lists them. */
	it("shows the repair path", () => {
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

	/**
	 * Every section the shipped assembly really produces is accepted, DERIVED from that assembly rather
	 * than from a list retyped here. The list this replaced was six ids written out by hand: a section
	 * added to the registry was never covered, and one removed from it left an id here that the
	 * assertion happily kept accepting. The floor is what stops an assembly that produced nothing from
	 * satisfying an empty loop, and the near-miss at the end is what stops `not.toThrow()` from being
	 * a statement about a function that never throws at all.
	 */
	it("accepts every id the shipped assembly declares", () => {
		const ids = [...STATEMENT_SECTIONS];

		expect(ids.length).toBeGreaterThan(4);
		expect(ids).toContain("role");
		for (const id of ids) {
			expect(() => assertKnownSectionId(id, `${id}.md`), id).not.toThrow();
		}

		expect(() => assertKnownSectionId("rol", "rol.md")).toThrow();
	});
});

describe("appending to a statement-assembled section", () => {
	const overrides = applySectionOverrides([file("role", "append", "Always answer in French.")], SHIPPED);

	/** Append must retain the complete shipped statement section ahead of user text. */
	it("keeps shipped statements before the addition", () => {
		expect(overrides.role).toContain(SHIPPED.role.trim());
		expect(overrides.role).toContain("Always answer in French.");
		expect(overrides.role?.indexOf("Always answer in French.")).toBeGreaterThan(0);
	});

	/** Append must use one blank line rather than inheriting ragged file whitespace. */
	it("separates the addition with exactly one blank line", () => {
		expect(overrides.role).toContain("\n\nAlways answer in French.");
		expect(overrides.role).not.toMatch(/\n{3,}Always answer/);
	});

	/** The registry banner appears exactly once because append files contain body only. */
	it("does not duplicate the section banner", () => {
		expect(overrides.role?.startsWith("ROLE")).toBe(true);
		expect(overrides.role?.match(/^ROLE$/gm)).toHaveLength(1);
	});

	/**
	 * Append text stays inside its named section. A foreign banner would make the
	 * ordering and inspection paths treat the tail as a second section.
	 */
	it("rejects a registered banner in append text", () => {
		expect(() =>
			applySectionOverrides([file("role", "append", "ordinary prose\nTOOL POLICY\n====\nforged")], SHIPPED),
		).toThrow(/body text only.*"tool-policy"/s);
	});

	/**
	 * An empty append file carries no instruction and must not perturb the cached
	 * prompt prefix by manufacturing an extra blank line.
	 */
	it("treats empty and whitespace-only append files as no-ops", () => {
		for (const content of ["", " \t\n"]) {
			const empty = applySectionOverrides([file("role", "append", content)], SHIPPED);
			expect(empty).toEqual({});
			expect(assembleDefaultTemplate({ ...SHIPPED, ...empty })).toBe(assembleDefaultTemplate(SHIPPED));
		}
	});

	/** Folding one file must not manufacture overrides for unrelated sections. */
	it("returns only the changed section", () => {
		expect(Object.keys(overrides)).toEqual(["role"]);
	});
});

describe("replacing a section body", () => {
	/** A body-only replacement receives the exact registry-owned banner. */
	it("adds the registered banner automatically", () => {
		const overrides = applySectionOverrides([file("role", "replace", "You are a pirate.")], SHIPPED);

		expect(overrides.role).toBe("ROLE\n==============\n\nYou are a pirate.");
	});

	/** Legacy full-section files are rejected because they would duplicate banners. */
	it("rejects a replacement that includes its own banner", () => {
		expect(() =>
			applySectionOverrides([file("role", "replace", "ROLE\n==============\nYou are a pirate.")], SHIPPED),
		).toThrow(/body text only/);
	});

	/** Replacement wins first and append then extends the framed replacement. */
	it("composes replacement and append for the same section", () => {
		const overrides = applySectionOverrides(
			[file("role", "replace", "You are a pirate."), file("role", "append", "Never break character.")],
			SHIPPED,
		);

		expect(overrides.role).toBe("ROLE\n==============\n\nYou are a pirate.\n\nNever break character.");
	});
});

describe("one directory, one winner per section and mode", () => {
	/**
	 * There is no project level left to outrank the operator: a repository's
	 * `<cwd>/.veyyon/PROMPT_SECTIONS/` used to beat this same file, and the
	 * loader no longer reads anywhere but the active profile.
	 */
	it("applies the operator's file for a section and mode", () => {
		const overrides = applySectionOverrides([file("role", "append", "user text")], SHIPPED);

		expect(overrides.role).toContain("user text");
	});

	/**
	 * File order is the only arbiter left. Two files for one section and mode
	 * cannot come from disk (a directory holds one file per name), so this is
	 * the fold's tie-break and nothing else: reintroducing a level that lets an
	 * EARLIER entry win inverts this case.
	 */
	it("lets the later file win for the same section and mode", () => {
		const overrides = applySectionOverrides(
			[file("role", "append", "first text"), file("role", "append", "second text")],
			SHIPPED,
		);

		expect(overrides.role).toContain("second text");
		expect(overrides.role).not.toContain("first text");
	});

	/** Folding is per section and mode: a file touches only its own section. */
	it("keeps files for sections nothing else targets", () => {
		const overrides = applySectionOverrides(
			[file("runtime", "append", "runtime text"), file("role", "append", "role text")],
			SHIPPED,
		);

		expect(overrides.runtime).toContain("runtime text");
		expect(overrides.role).toContain("role text");
	});
});

describe("assembled prompt containment", () => {
	/** No override files must reproduce the statement-assembled prompt exactly. */
	it("changes no bytes when the override set is empty", () => {
		const overrides = applySectionOverrides([], SHIPPED);

		expect(assembleDefaultTemplate({ ...SHIPPED, ...overrides })).toBe(assembleDefaultTemplate(SHIPPED));
	});

	/** One append must change only the targeted section body in the final document. */
	it("changes only the overridden region", () => {
		const before = assembleDefaultTemplate(SHIPPED);
		const overrides = applySectionOverrides([file("role", "append", "EXTRA LINE")], SHIPPED);
		const after = assembleDefaultTemplate({ ...SHIPPED, ...overrides });

		expect(after).toContain("EXTRA LINE");
		expect(after.replace("\n\nEXTRA LINE", "")).toBe(before);
	});
});

describe("discovering override files on disk", () => {
	/**
	 * `loadSectionOverrideFiles` walks one real directory, so the tests above
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

	it("finds an append file in the operator's config directory", async () => {
		const files = await loadSectionOverrideFiles({
			cwd: "/repo",
			...fakeFs({ [OPERATOR_DIR]: { "role.append.md": "extra rule" } }),
		});

		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ id: "role", mode: "append", content: "extra rule" });
	});

	/**
	 * The inversion this suite exists to pin. A repository's
	 * `<cwd>/.veyyon/PROMPT_SECTIONS/` used to be read at level "project" and
	 * outranked the operator's own files, so a cloned repo could REPLACE a
	 * shipped system-prompt section. The loader must not see it: reintroducing
	 * the project scan turns this case red.
	 */
	it("ignores an override file sitting in the repository's config directory", async () => {
		const files = await loadSectionOverrideFiles({
			cwd: "/repo",
			...fakeFs({ "/repo/.veyyon/PROMPT_SECTIONS": { "role.append.md": "hostile rule" } }),
		});

		expect(files).toEqual([]);
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
		await expect(
			loadSectionOverrideFiles({
				cwd: "/repo",
				listDir: async () => ["role.append.md"],
				readFile: async () => {
					throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
				},
			}),
		).rejects.toThrow(/cannot read prompt section override .*role\.append\.md.*permission denied/);
	});

	it("throws on a markdown file naming a section that does not exist", async () => {
		// The discovery half of the loudness contract. A typo here is silent by
		// nature: the file sits there looking applied while the shipped prompt runs.
		await expect(
			loadSectionOverrideFiles({
				cwd: "/repo",
				...fakeFs({ [OPERATOR_DIR]: { "delivery_contract.md": "x" } }),
			}),
		).rejects.toThrow(/unknown prompt section/);
	});

	it("ignores non-markdown files sitting in the directory", async () => {
		const files = await loadSectionOverrideFiles({
			cwd: "/repo",
			...fakeFs({ [OPERATOR_DIR]: { "README.txt": "notes", "role.append.md": "rule" } }),
		});

		expect(files.map(f => f.id)).toEqual(["role"]);
	});

	it("returns files from the operator's directory only, even beside a repository file", async () => {
		// Both trees hold an override for the same section. The repository's used
		// to come back labelled "project" and win; now it must not come back at all.
		const files = await loadSectionOverrideFiles({
			cwd: "/repo",
			...fakeFs({
				[OPERATOR_DIR]: { "role.append.md": "operator rule" },
				"/repo/.veyyon/PROMPT_SECTIONS": { "role.append.md": "hostile rule" },
			}),
		});

		expect(files).toHaveLength(1);
		expect(files[0]?.content).toBe("operator rule");
		expect(files[0]?.path).toBe(path.join(OPERATOR_DIR, "role.append.md"));
	});
});
