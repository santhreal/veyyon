/**
 * Seeding the roster from disk, in a process that drives TWO conversations.
 *
 * WHY TWO. The scan registers `parked` refs for the subagents a previous run
 * left on disk. Their conversation used to be INHERITED, through a parent chain
 * that terminates at the constant `MAIN_AGENT_ID`. That is the driving agent's
 * id only in the interactive TUI: an ACP root registers as `acp:<sessionId>`, so
 * in exactly the hosts that drive several conversations there is no `Main` ref
 * to inherit from and every seeded ref landed with an UNDEFINED scope. An
 * undefined scope is deliberately visible to EVERYONE, so one conversation
 * opening its Control Center published its whole on-disk subagent tree into
 * every other conversation's roster.
 *
 * A one-conversation test cannot see this. With a single roster there is nobody
 * for the undefined scope to leak to, and the seeded rows look correct because
 * they are the only rows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@veyyon/coding-agent/registry/persisted-subagents";

let root: string;
let registry: AgentRegistry;

beforeEach(async () => {
	AgentRegistry.resetGlobalForTests();
	registry = AgentRegistry.global();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "persisted-subagents-"));
	// `<root>/acp-a.jsonl` owns `<root>/acp-a/`, which holds its subagents.
	await fs.mkdir(path.join(root, "acp-a", "Scout"), { recursive: true });
	await fs.writeFile(path.join(root, "acp-a.jsonl"), "");
	await fs.writeFile(path.join(root, "acp-a", "Scout.jsonl"), "");
	await fs.writeFile(path.join(root, "acp-a", "Scout", "Nested.jsonl"), "");
});

afterEach(async () => {
	AgentRegistry.resetGlobalForTests();
	await fs.rm(root, { recursive: true, force: true });
});

describe("Persisted subagents belong to the conversation that seeded them", () => {
	/**
	 * Asserted on the ref's own `scope`, and at DEPTH, because the nested child is
	 * the case inheritance was supposed to cover and the one a shallow fixture
	 * would miss. `Main` is deliberately absent from the registry: that is the ACP
	 * and SDK shape, and it is what made the inherited scope undefined.
	 */
	test("stamps the stated conversation on every seeded ref, at any depth", async () => {
		const added = await registerPersistedSubagents(registry, path.join(root, "acp-a.jsonl"), "session-a");

		expect(added).toBe(2);
		expect(registry.get("Scout")?.scope).toBe("session-a");
		expect(registry.get("Nested")?.scope).toBe("session-a");
	});

	/**
	 * The consequence, stated as the roster question the operator actually asks.
	 * Another conversation's card must not gain rows it never spawned. Both
	 * directions in one test: A keeps them, B does not get them.
	 */
	test("keeps seeded rows out of another conversation's roster", async () => {
		registry.register({ id: "acp:b", displayName: "main", kind: "main", session: null, scope: "session-b" });
		await registerPersistedSubagents(registry, path.join(root, "acp-a.jsonl"), "session-a");

		expect(registry.listInScope("session-a").map(ref => ref.id)).toContain("Scout");
		expect(registry.listInScope("session-b").map(ref => ref.id)).not.toContain("Scout");
		expect(registry.listInScope("session-b").map(ref => ref.id)).not.toContain("Nested");
	});

	/**
	 * A caller that states no conversation still seeds, unattributed and therefore
	 * visible everywhere. That is the render-only and single-session path, and
	 * hiding those rows would be a blank Control Center rather than a scoped one.
	 */
	test("still seeds when the caller states no conversation", async () => {
		const added = await registerPersistedSubagents(registry, path.join(root, "acp-a.jsonl"));

		expect(added).toBe(2);
		expect(registry.get("Scout")?.scope).toBeUndefined();
	});
});
