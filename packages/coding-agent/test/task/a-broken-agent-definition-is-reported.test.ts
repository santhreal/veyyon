/**
 * A subagent definition that cannot be read or parsed says so, instead of just not existing.
 *
 * THE BUG. `loadAgentsFromDir` already treated an unlistable agents DIRECTORY as a fault worth
 * reporting: `readdirIfPresent` routes it through `reportFault`, and its own comment says the
 * point is that "the user's subagents disappear from `/agents` with no sign of why". The
 * per-FILE failure five lines below is the identical loss one agent at a time — the user wrote
 * a definition, it is absent from `/agents` and unusable from `task`, and the run continues as
 * if nothing were configured — and it was handled with `logger.warn`. The default transport set
 * is `{ file: true }` with no console transport, so that report reached a file nobody opens;
 * `utils/fault-sink.ts` exists because of exactly this asymmetry.
 *
 * WHERE THE FIXTURES LIVE. The profile's `agents/` dir, reached by passing `agentDir` to
 * `discoverAgents`. They used to live in `<cwd>/.veyyon/agents`, which stopped being a source
 * when project definitions were removed so a repository could not shadow a bundled role. That
 * left both cases writing into a directory nothing reads, so they raised no faults and had been
 * failing since. The operator-facing contract is unchanged: it is the same loader and the same
 * `reportFault` channel, exercised through a scope that is actually scanned.
 *
 * WHAT THIS LOCKS. Both file-level failures now go through `reportFault`, the same channel the
 * directory-level failure already used, and `test/sdk-fault-sink-follows-the-session.test.ts`
 * proves that channel lands in the live session's operator notices.
 *
 * THE INPUT IS REAL. One definition has genuinely unusable frontmatter and one is a dangling
 * symlink, both written to disk and read by the live loader. No error object is constructed and
 * no reader is stubbed; the fault text under assertion is produced by the real failure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { discoverAgents } from "@veyyon/coding-agent/task/discovery";
import { attachFaultSink, type DetachFaultSink, type Fault, removeWithRetries } from "@veyyon/utils";

const HEALTHY_AGENT_MD = ["---", "name: diff-reader", "description: Reviews a diff.", "---", "You review."].join("\n");

// Real frontmatter that the agent contract cannot use: `description` is required and
// absent, so `parseAgentFields` returns null and `parseAgent` throws. This is what a
// half-written definition actually looks like, not a synthetic error.
const UNUSABLE_AGENT_MD = ["---", "name: auditor", "---", "You audit."].join("\n");

describe("a broken agent definition is reported rather than dropped", () => {
	let tempHome = "";
	let projectDir = "";
	let profileDir = "";
	let agentsDir = "";
	let faults: Fault[] = [];
	let detach: DetachFaultSink | undefined;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-broken-agent-def-"));
		projectDir = path.join(tempHome, "project");
		profileDir = path.join(tempHome, "profile");
		agentsDir = path.join(profileDir, "agents");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentsDir, { recursive: true });
		faults = [];
		detach = attachFaultSink(fault => faults.push(fault));
	});

	afterEach(async () => {
		detach?.();
		detach = undefined;
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	/** Only the faults this suite's own directory produced, so a host-level fault cannot pass it. */
	function agentFaults(): Fault[] {
		return faults.filter(fault => fault.source === "agents" && String(fault.context?.filePath).startsWith(agentsDir));
	}

	/**
	 * Frontmatter the contract cannot use. The agent is genuinely gone, which is not the bug;
	 * the run being silent about it was.
	 */
	test("reports a definition whose frontmatter cannot be used", async () => {
		await fs.writeFile(path.join(agentsDir, "diff-reader.md"), HEALTHY_AGENT_MD);
		await fs.writeFile(path.join(agentsDir, "auditor.md"), UNUSABLE_AGENT_MD);

		const { agents } = await discoverAgents(projectDir, tempHome, profileDir);
		const names = agents.map(agent => agent.name);

		// Soft failure preserved: the healthy sibling still loads.
		expect(names).toContain("diff-reader");
		expect(names).not.toContain("auditor");

		const reported = agentFaults();
		expect(reported).toHaveLength(1);
		expect(reported[0].text).toBe(
			`${path.join(agentsDir, "auditor.md")} could not be read as an agent definition, so that agent is not available in this run. ` +
				"Check its permissions and its YAML frontmatter, which must set both name and description.",
		);
		expect(reported[0].context?.filePath).toBe(path.join(agentsDir, "auditor.md"));
	});

	/**
	 * A definition that exists as a directory entry and cannot be read at all. A dangling
	 * symlink is the deterministic version of the permissions case: the loader sees a `.md`
	 * entry, the read fails for real, and nothing about the outcome tells the user which file.
	 */
	test("reports a definition that cannot be read from disk", async () => {
		await fs.symlink(path.join(tempHome, "no-such-agent-source.md"), path.join(agentsDir, "ghost.md"));

		const { agents } = await discoverAgents(projectDir, tempHome, profileDir);

		expect(agents.map(agent => agent.name)).not.toContain("ghost");

		const reported = agentFaults();
		expect(reported).toHaveLength(1);
		expect(reported[0].source).toBe("agents");
		expect(reported[0].context?.filePath).toBe(path.join(agentsDir, "ghost.md"));
		expect(String(reported[0].context?.error)).toContain("ENOENT");
	});

	/**
	 * A directory of healthy definitions raises nothing. Without this the suite would still
	 * pass if the fix reported on every file, and a channel that always speaks is ignored.
	 */
	test("stays quiet when every definition is usable", async () => {
		await fs.writeFile(path.join(agentsDir, "reviewer.md"), HEALTHY_AGENT_MD);

		const { agents } = await discoverAgents(projectDir, tempHome);

		expect(agents.map(agent => agent.name)).toContain("reviewer");
		expect(agentFaults()).toEqual([]);
	});
});
