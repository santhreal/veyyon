/**
 * The edit tool survives every provider and every model switch.
 *
 * WHY THIS SUITE EXISTS. `sdk.ts` ran `toolRegistry.delete(TOOL.edit)` when a session was
 * constructed on a cursor model. The registry is built exactly once, so the deletion was
 * permanent: a session that merely STARTED on a cursor model and then switched to Anthropic or
 * OpenAI spent the rest of its life with no edit tool. Nothing reported it, because
 * `#applyActiveToolsByName` discards a requested name that is absent from the registry with no
 * log and no error — the session's own `session_init` record still listed `edit` among its 22
 * active tools while only 21 were ever advertised. With `modelRoles.default` pointing at a
 * cursor model, that is every session the operator starts, on every provider, forever.
 *
 * WHY NO EXCLUSION IS CORRECT, rather than a per-model one. The deletion landed inside the
 * catch-all commit `33fd00971` with no comment and no mention in its message, and the premise it
 * implies is false: `CURSOR_NATIVE_TOOL_NAMES` in `packages/ai/src/providers/cursor.ts` is the
 * list of tools cursor-agent supplies itself, and those names are filtered out of the advertised
 * set precisely because cursor already has them. `edit` is NOT in that list. Withholding it
 * leaves a cursor session with no anchored edit at all, only whole-file `write`, which is a
 * strict downgrade.
 *
 * WHAT THIS LOCKS. Not "cursor stops deleting edit", which is the incident. The contract is that
 * the advertised tool set does not depend on which model the session happened to OPEN on. The
 * third test is the falsification guard: it passes against the old code too, and exists to fail
 * the tempting wrong fix of keeping the exclusion but re-evaluating it per model. Any change
 * that withholds `edit` from a live provider turns it red.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@veyyon/catalog/build";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";

const CURSOR_MODEL = buildModel({
	id: "cursor-composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

const ANTHROPIC_MODEL = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

describe("the edit tool survives every provider and every model switch", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	async function openSession(model: typeof CURSOR_MODEL): Promise<AgentSession> {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "tool-exclusion-"));
		dirs.push(home);
		const cwd = path.join(home, "workspace");
		const agentDir = path.join(home, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const authStorage = new AuthStorage(agentDir);
		authStorage.setRuntimeApiKey("cursor", "test-token");
		authStorage.setRuntimeApiKey("anthropic", "test-token");

		const created = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.create(cwd, path.join(home, "sessions")),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({ "async.enabled": false, "advisor.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return created.session;
	}

	/** The names actually bound to the agent, which is what a provider request carries. */
	function advertised(session: AgentSession): string[] {
		return session.agent.state.tools.map(tool => tool.name);
	}

	it("offers edit to a session opened on a cursor model", async () => {
		const session = await openSession(CURSOR_MODEL);

		expect(advertised(session)).toContain("edit");
	});

	it("keeps edit after a session opened on cursor switches to another provider", async () => {
		const session = await openSession(CURSOR_MODEL);

		await session.setModel(ANTHROPIC_MODEL);

		expect(advertised(session)).toContain("edit");
	});

	it("keeps edit after a session switches onto a cursor model", async () => {
		const session = await openSession(ANTHROPIC_MODEL);
		expect(advertised(session)).toContain("edit");

		await session.setModel(CURSOR_MODEL);

		expect(advertised(session)).toContain("edit");
	});
});
