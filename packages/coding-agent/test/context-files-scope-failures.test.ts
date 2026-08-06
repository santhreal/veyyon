import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setDisabledProviders } from "@veyyon/coding-agent/capability";
import { loadProjectContextFiles, loadProjectContextFilesWithWarnings } from "@veyyon/coding-agent/system-prompt";
import {
	GLOBAL_BODY,
	PROFILE_BODY,
	PROJECT_NESTED_BODY,
	PROJECT_ROOT_BODY,
	useContextScopeFixture,
} from "./helpers/context-scope-fixture";

const fixture = useContextScopeFixture("context-scope-failures-");

/** Root ignores mode bits, so the unreadable-file case cannot be staged there. */
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Adversarial inputs to scope resolution.
 *
 * The reported bug was not a crash. It was an EMPTY LIST, and an empty list
 * renders as nothing at all because both prompt templates gate the whole context
 * block on `{{#if contextFiles.length}}`. So every degenerate input below has to
 * be pinned twice: the bad file must not appear, AND the healthy scopes beside it
 * must survive. A loader that answers a permissions error, a directory named
 * `AGENTS.md`, or a zero-byte file by returning `[]` reproduces the original
 * failure exactly, and no assertion about the bad file alone would notice.
 */
describe("context file scope failures", () => {
	/**
	 * The overwhelmingly common case: most installs have no file in most scopes.
	 * A missing file is a normal probe miss, so it must be silent, and it must
	 * not stop the walk that follows it.
	 */
	it("treats a missing scope as silent and keeps the scopes that do exist", async () => {
		const f = fixture("failure-missing");
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);

		const { files, warnings } = await loadProjectContextFilesWithWarnings({ cwd: f.cwd, agentDir: f.agentDir });

		expect(fs.existsSync(f.globalAgentsPath)).toBe(false);
		expect(files).toEqual([
			{ path: f.rootAgentsPath, level: "project", content: `${PROJECT_ROOT_BODY}\n`, depth: 1 },
		]);
		expect(warnings).toEqual([]);
	});

	/**
	 * A file that EXISTS but cannot be read is the one case that must never be
	 * silent. This is Law 10 in file form: the operator wrote rules, the rules
	 * are on disk, and the agent is ignoring them. Without a warning naming the
	 * path, the only symptom is an agent that quietly stopped following
	 * instructions, which is precisely how the reported bug survived.
	 *
	 * EXACTLY ONE warning for the path, and it carries the errno. Two owners read
	 * these two scopes (the native capability provider, and the loader's fallback
	 * pass for a narrowed provider set), and both used to report the same failed
	 * path, which is how an operator learns to skim past warnings. The provider
	 * speaks first and now names the errno; the fallback pass stays quiet about a
	 * path already reported. If the count regresses to two, the duplicate is back;
	 * if it regresses to one WITHOUT an errno, the loader's message was kept and
	 * the provider's enriched read was lost.
	 */
	it.skipIf(runningAsRoot)("warns with the absolute path when an existing context file cannot be read", async () => {
		const f = fixture("failure-eacces");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		fs.chmodSync(f.globalAgentsPath, 0o000);
		f.resetCaches();

		const { files, warnings } = await loadProjectContextFilesWithWarnings({ cwd: f.cwd, agentDir: f.agentDir });
		fs.chmodSync(f.globalAgentsPath, 0o600);

		expect(files).toEqual([
			{ path: f.rootAgentsPath, level: "project", content: `${PROJECT_ROOT_BODY}\n`, depth: 1 },
		]);
		expect(warnings.filter(warning => warning.includes(f.globalAgentsPath)).length).toBe(1);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("could not be read");
		expect(warnings[0]).toContain("EACCES");
	});

	/**
	 * A zero-byte file is a user who created the file and has not written
	 * anything yet. It contributes nothing, which is correct, but it must not be
	 * confused with a read failure (no warning) and must not shorten the walk.
	 */
	it("contributes nothing for an empty file without warning or dropping other scopes", async () => {
		const f = fixture("failure-empty");
		f.writeFile(f.globalAgentsPath, "");
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);

		const { files, warnings } = await loadProjectContextFilesWithWarnings({ cwd: f.cwd, agentDir: f.agentDir });

		expect(files).toEqual([
			{ path: f.nestedAgentsPath, level: "project", content: `${PROJECT_NESTED_BODY}\n`, depth: 0 },
			{ path: f.profileAgentsPath, level: "user", content: `${PROFILE_BODY}\n`, depth: undefined },
		]);
		expect(warnings).toEqual([]);
	});

	/**
	 * A DIRECTORY named `AGENTS.md` is what a mis-run `mkdir -p` leaves behind,
	 * and reading one throws EISDIR. The loader gates on the stat result rather
	 * than catching the throw, so the entry is skipped: the point of this case is
	 * that the ancestor walk continues past it instead of aborting and losing
	 * every scope above.
	 */
	it("skips a directory named AGENTS.md and keeps walking to the repo root", async () => {
		const f = fixture("failure-directory");
		fs.mkdirSync(f.nestedAgentsPath, { recursive: true });
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.resetCaches();

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: f.agentDir });

		expect(fs.statSync(f.nestedAgentsPath).isDirectory()).toBe(true);
		expect(files).toEqual([
			{ path: f.rootAgentsPath, level: "project", content: `${PROJECT_ROOT_BODY}\n`, depth: 1 },
			{ path: f.globalAgentsPath, level: "global", content: `${GLOBAL_BODY}\n`, depth: undefined },
		]);
	});

	/**
	 * A symlinked `AGENTS.md` is the standard way a monorepo shares one ruleset
	 * across packages. The stat that rejects directories and devices follows
	 * symlinks, so the link must resolve to its target's content while the entry
	 * keeps the LINK's path: the path is what the prompt shows the model, and
	 * showing the target would name a file the model cannot find at that
	 * location.
	 */
	it("follows a symlinked context file and reports the link path", async () => {
		const f = fixture("failure-symlink");
		const shared = f.writeFile(path.join(f.repoRoot, "shared-rules.md"), `${PROJECT_NESTED_BODY}\n`);
		fs.symlinkSync(shared, f.nestedAgentsPath);
		f.resetCaches();

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: f.agentDir });

		expect(fs.lstatSync(f.nestedAgentsPath).isSymbolicLink()).toBe(true);
		expect(files).toEqual([
			{ path: f.nestedAgentsPath, level: "project", content: `${PROJECT_NESTED_BODY}\n`, depth: 0 },
		]);
	});

	/**
	 * Two scopes holding the SAME text is what happens when a user copies their
	 * global rules into a project, or a project quotes them. Sending both wastes
	 * context and makes the duplicated block look twice as authoritative, so one
	 * copy is dropped.
	 *
	 * WHICH copy survives is not cosmetic. The survivor's `<file path=...>` label is
	 * what tells the model which rules it is reading, so keeping the project copy
	 * re-attributes the operator's own standing rules to a repository file: same
	 * bytes, and a project file now wearing the authority of the user's own
	 * configuration. The dedupe therefore keeps the copy from the more
	 * AUTHORITATIVE scope, read from the same rank table the render order uses, not
	 * the copy that happens to sit later in the array.
	 */
	it("keeps the copy from the most authoritative scope when two scopes hold identical text", async () => {
		const f = fixture("failure-duplicate");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${GLOBAL_BODY}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: f.agentDir });

		expect(files).toEqual([
			{ path: f.globalAgentsPath, level: "global", content: `${GLOBAL_BODY}\n`, depth: undefined },
		]);
	});

	/**
	 * A project file that QUOTES the operator's global rules inside a longer file is
	 * the case that decides the direction of the whole rule. The global file's
	 * blocks are a subset of the project file's, so containment points from global
	 * to project, and a position-driven dedupe drops the global copy: the operator's
	 * own rules survive only as text inside a repository file, labelled with the
	 * repository's path.
	 *
	 * Both must survive. The global copy is kept because it outranks, and the
	 * project file is left byte-identical because the dedupe drops whole files and
	 * never rewrites what an author wrote.
	 */
	it("keeps the global file whole when a longer project file quotes it", async () => {
		const f = fixture("failure-quoted-global");
		const quoting = `# Package rules\n\n${GLOBAL_BODY}\n\nAlso run the package linter.\n`;
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, quoting);

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: f.agentDir });

		expect(files).toEqual([
			{ path: f.nestedAgentsPath, level: "project", content: quoting, depth: 0 },
			{ path: f.globalAgentsPath, level: "global", content: `${GLOBAL_BODY}\n`, depth: undefined },
		]);
	});

	/**
	 * When cwd IS the repo root, the single file there is reachable as both the
	 * cwd entry and the root entry of the same walk. It must be emitted once, at
	 * depth 0. A double emission would render the same rules twice and, because
	 * the two copies carry different depths, would also make the ordering
	 * assertions in the sibling suite ambiguous.
	 */
	it("emits a repo-root file reachable at two walk positions exactly once", async () => {
		const f = fixture("failure-same-path");
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.resetCaches();

		const files = await loadProjectContextFiles({ cwd: f.repoRoot, agentDir: f.agentDir });

		expect(files).toEqual([
			{ path: f.rootAgentsPath, level: "project", content: `${PROJECT_ROOT_BODY}\n`, depth: 0 },
		]);
	});

	/**
	 * One directory holding both `AGENTS.md` and `CLAUDE.md` is a repo stating
	 * the same rules twice for two different tools. Loading both would duplicate
	 * the ruleset; letting directory-read order pick would make the prompt
	 * nondeterministic across machines. `AGENTS.md` wins because it is the
	 * tool-neutral convention.
	 */
	it("prefers AGENTS.md over CLAUDE.md in the same directory", async () => {
		const f = fixture("failure-claude");
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);
		const claudePath = f.writeFile(path.join(f.cwd, "CLAUDE.md"), "Marker: CLAUDE-BYTES-b820.\n");
		f.resetCaches();

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: f.agentDir });

		expect(fs.existsSync(claudePath)).toBe(true);
		expect(files).toEqual([
			{ path: f.nestedAgentsPath, level: "project", content: `${PROJECT_NESTED_BODY}\n`, depth: 0 },
		]);
	});

	/**
	 * Disabling the `native` provider now actually disables veyyon's own context
	 * scopes, which is a DELIBERATE behavior change made when the loader's
	 * re-resolution pass was deleted.
	 *
	 * That pass re-read `<config root>/AGENTS.md` and the profile ladder itself, keyed
	 * against the provider results. It existed to correct a provider that resolved the
	 * process-global profile; that is fixed at the source, and on a 16-case fixture
	 * matrix the pass then changed nothing at all EXCEPT here, where it re-added both
	 * scopes after the operator had switched the provider off. A setting that the code
	 * quietly overrules is worse than no setting, so the disable wins.
	 *
	 * If this regresses to returning the two files, the compensation pass is back and
	 * `disabledProviders` is decorative again.
	 */
	it("returns nothing from veyyon's own scopes when the native provider is disabled", async () => {
		const f = fixture("failure-provider-disabled");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		setDisabledProviders(["native"]);
		try {
			const { files, warnings } = await loadProjectContextFilesWithWarnings({ cwd: f.cwd, agentDir: f.agentDir });
			expect(files).toEqual([]);
			expect(warnings).toEqual([]);
		} finally {
			setDisabledProviders([]);
		}
	});

	/**
	 * A `.veyyon/AGENTS.md` must not terminate the project walk.
	 *
	 * The native provider used to RETURN the moment it found the nearest
	 * `.veyyon/AGENTS.md`, discarding every bare `AGENTS.md` from that directory
	 * up to the repo root. A repo that adopted a project config directory
	 * therefore silently lost its own root rules, and the loss scaled with how
	 * organized the repo was.
	 */
	it("keeps walking to the repo root past a project config-dir AGENTS.md", async () => {
		const f = fixture("failure-config-dir");
		const configAgentsPath = f.writeFile(
			path.join(f.cwd, ".veyyon", "AGENTS.md"),
			"Marker: CONFIG-DIR-BYTES-2f65.\n",
		);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.resetCaches();

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: f.agentDir });

		expect(files).toEqual([
			{ path: f.rootAgentsPath, level: "project", content: `${PROJECT_ROOT_BODY}\n`, depth: 1 },
			{ path: configAgentsPath, level: "project", content: "Marker: CONFIG-DIR-BYTES-2f65.\n", depth: 0 },
		]);
	});
});
