import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { contextFileCapability } from "@veyyon/coding-agent/capability/context-file";
import {
	ensureActiveProfileAgentsFile,
	ensureProfileAgentsFileAt,
	GLOBAL_AGENTS_GUIDANCE,
	PROFILE_AGENTS_GUIDANCE,
	stripManagedGuidance,
} from "@veyyon/coding-agent/discovery/agents-guidance";
import { setAgentDir, TempDir } from "@veyyon/utils";

describe("stripManagedGuidance", () => {
	test("a file that is only the managed header strips to empty", () => {
		expect(stripManagedGuidance(GLOBAL_AGENTS_GUIDANCE)).toBe("");
		expect(stripManagedGuidance(PROFILE_AGENTS_GUIDANCE)).toBe("");
	});

	test("real instructions after the header survive; the header is removed", () => {
		const file = `${GLOBAL_AGENTS_GUIDANCE}\nAlways prefer tabs over spaces.\nRun the linter before committing.\n`;
		const stripped = stripManagedGuidance(file);
		expect(stripped).toBe("Always prefer tabs over spaces.\nRun the linter before committing.\n");
		// The sentinel markers must be gone entirely.
		expect(stripped).not.toContain("veyyon:guidance");
		expect(stripped).not.toContain("veyyon:end");
	});

	test("a user's own HTML comment is left untouched", () => {
		const file = "<!-- my own note -->\nUse pnpm, not npm.\n";
		expect(stripManagedGuidance(file)).toBe(file);
	});

	test("content with no managed block is returned unchanged", () => {
		const file = "Line one.\nLine two.\n";
		expect(stripManagedGuidance(file)).toBe(file);
	});

	test("a header pasted lower in the file is also removed", () => {
		const file = `Top instruction.\n${PROFILE_AGENTS_GUIDANCE}Bottom instruction.\n`;
		const stripped = stripManagedGuidance(file);
		expect(stripped).toBe("Top instruction.\nBottom instruction.\n");
		expect(stripped).not.toContain("veyyon:guidance");
	});
});

describe("ensureProfileAgentsFileAt", () => {
	test("seeds AGENTS.md with the profile header, owner-group readable, once", async () => {
		const tempDir = TempDir.createSync("@agents-guidance-");
		try {
			const agentDir = tempDir.path();
			const agentsPath = path.join(agentDir, "AGENTS.md");
			expect(fs.existsSync(agentsPath)).toBe(false);

			await ensureProfileAgentsFileAt(agentDir);
			expect(fs.readFileSync(agentsPath, "utf-8")).toBe(PROFILE_AGENTS_GUIDANCE);
			expect(fs.statSync(agentsPath).mode & 0o777).toBe(0o644);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	test("never clobbers an AGENTS.md the user has already filled in", async () => {
		const tempDir = TempDir.createSync("@agents-guidance-");
		try {
			const agentDir = tempDir.path();
			const agentsPath = path.join(agentDir, "AGENTS.md");
			const userContent = "My hand-written profile rules.\n";
			fs.writeFileSync(agentsPath, userContent);

			await ensureProfileAgentsFileAt(agentDir);
			// The existing file is preserved byte-for-byte; the header is not injected.
			expect(fs.readFileSync(agentsPath, "utf-8")).toBe(userContent);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});
});

describe("ensureActiveProfileAgentsFile (startup back-fill for pre-existing profiles)", () => {
	// A profile that predates profile-creation seeding would otherwise never get a
	// persistent AGENTS.md, which is what pushed a user to edit a file inside the
	// git checkout that every update reset away. These pin the back-fill AND its
	// shadow-safety: a blank high-priority AGENTS.md must never be seeded over a
	// user's existing lower-priority agent.md, and an existing symlink (the exact
	// real-world case) must be left untouched.
	const originalAgentDir = process.env.VEYYON_CODING_AGENT_DIR;
	function withAgentDir<T>(agentDir: string, run: () => T): T {
		setAgentDir(agentDir);
		try {
			return run();
		} finally {
			if (originalAgentDir === undefined) delete process.env.VEYYON_CODING_AGENT_DIR;
			else setAgentDir(originalAgentDir);
		}
	}

	test("seeds <agentDir>/AGENTS.md when the profile carries no instruction file", async () => {
		const tempDir = TempDir.createSync("@agents-startup-");
		try {
			const agentDir = path.join(tempDir.path(), "agent");
			const agentsPath = path.join(agentDir, "AGENTS.md");
			await withAgentDir(agentDir, () => ensureActiveProfileAgentsFile());
			expect(fs.readFileSync(agentsPath, "utf-8")).toBe(PROFILE_AGENTS_GUIDANCE);
			expect(fs.statSync(agentsPath).mode & 0o777).toBe(0o644);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	test("does NOT seed a high-priority AGENTS.md over an existing lower-priority agent.md", async () => {
		const tempDir = TempDir.createSync("@agents-startup-");
		try {
			const agentDir = path.join(tempDir.path(), "agent");
			fs.mkdirSync(agentDir, { recursive: true });
			// Lower-priority candidate: <agentDir>/agent.md. Seeding <agentDir>/AGENTS.md
			// would shadow it, since the loader reads the first candidate that exists.
			const lowerPath = path.join(agentDir, "agent.md");
			const userRules = "My real profile rules live in agent.md.\n";
			fs.writeFileSync(lowerPath, userRules);

			await withAgentDir(agentDir, () => ensureActiveProfileAgentsFile());

			expect(fs.existsSync(path.join(agentDir, "AGENTS.md"))).toBe(false);
			expect(fs.readFileSync(lowerPath, "utf-8")).toBe(userRules);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	test("never clobbers an AGENTS.md the profile already has", async () => {
		const tempDir = TempDir.createSync("@agents-startup-");
		try {
			const agentDir = path.join(tempDir.path(), "agent");
			fs.mkdirSync(agentDir, { recursive: true });
			const agentsPath = path.join(agentDir, "AGENTS.md");
			const userContent = "Existing top-priority rules.\n";
			fs.writeFileSync(agentsPath, userContent);

			await withAgentDir(agentDir, () => ensureActiveProfileAgentsFile());
			expect(fs.readFileSync(agentsPath, "utf-8")).toBe(userContent);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	test("leaves a symlinked AGENTS.md untouched (the reported real-world case)", async () => {
		const tempDir = TempDir.createSync("@agents-startup-");
		try {
			const agentDir = path.join(tempDir.path(), "agent");
			fs.mkdirSync(agentDir, { recursive: true });
			const externalTarget = path.join(tempDir.path(), "external-rules.md");
			const externalContent = "Rules the user symlinked in from elsewhere.\n";
			fs.writeFileSync(externalTarget, externalContent);
			const agentsPath = path.join(agentDir, "AGENTS.md");
			fs.symlinkSync(externalTarget, agentsPath);

			await withAgentDir(agentDir, () => ensureActiveProfileAgentsFile());

			// The symlink is preserved: still a link, still pointing at the target,
			// and its content is the external file, not the seeded header.
			expect(fs.lstatSync(agentsPath).isSymbolicLink()).toBe(true);
			expect(fs.readlinkSync(agentsPath)).toBe(externalTarget);
			expect(fs.readFileSync(agentsPath, "utf-8")).toBe(externalContent);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});
});

describe("context-file capability scopes global, user, and project distinctly", () => {
	const meta = { provider: "native", providerName: "", path: "/x/AGENTS.md", level: "user" as const };

	test("the dedup key keeps a global file and a user file as separate scopes", () => {
		const globalKey = contextFileCapability.key({
			path: "/home/u/.veyyon/AGENTS.md",
			content: "g",
			level: "global",
			_source: meta,
		});
		const userKey = contextFileCapability.key({
			path: "/home/u/.veyyon/profiles/default/agent/AGENTS.md",
			content: "u",
			level: "user",
			_source: meta,
		});
		expect(globalKey).toBe("global");
		expect(userKey).toBe("user");
		expect(globalKey).not.toBe(userKey);
	});

	test("validate accepts the global level and rejects an unknown one", () => {
		const validate = contextFileCapability.validate;
		if (!validate) throw new Error("context-file capability must define validate");
		expect(validate({ path: "/x/AGENTS.md", content: "c", level: "global", _source: meta })).toBeUndefined();
		// Feed an out-of-union level on purpose to exercise the rejection branch.
		const badLevel = { path: "/x/AGENTS.md", content: "c", level: "nope", _source: meta } as unknown as Parameters<
			typeof validate
		>[0];
		expect(validate(badLevel)).toBe("Invalid level: must be 'user', 'project', or 'global'");
	});
});
