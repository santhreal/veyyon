/**
 * `agent://<id>` when TWO conversations in one process produced the same output
 * id.
 *
 * WHY TWO. The handler searches the artifacts dirs of every registered session
 * in registry order. Output ids are the task names a model chose, so a
 * `Reviewer` in one conversation and a `Reviewer` in another are the ordinary
 * case, not a contrived one. "First dir wins" then returned the other
 * conversation's report under this conversation's id, with no error and nothing
 * on screen to suggest it. With one conversation registered there is only ever
 * one candidate, so the identical test passes on the broken code.
 *
 * This is the rule `sessionFilesFromDisk` already applies to `history://`
 * transcripts, applied to the `.md` output that sits beside them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { AgentProtocolHandler } from "../agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "../registry-helpers";

const tempDir = TempDir.createSync("veyyon-agent-scope-");

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

/** Register one conversation with its own artifacts dir, and return that dir. */
async function conversation(name: string, scope: string): Promise<string> {
	const sessionFile = path.join(tempDir.path(), `${name}.jsonl`);
	const artifactsDir = sessionFile.slice(0, -6);
	await fs.mkdir(artifactsDir, { recursive: true });
	AgentRegistry.global().register({
		id: name,
		displayName: "main",
		kind: "main",
		session: { sessionManager: { getArtifactsDir: () => artifactsDir } } as unknown as AgentSession,
		sessionFile,
		scope,
	});
	return artifactsDir;
}

describe("agent:// across conversations", () => {
	/**
	 * Refuses, and names both files. Returning either would be a guess, and the
	 * operator needs to know WHICH two candidates exist to pick one by path.
	 * `session-b` is registered first so any first-hit rule resolves to B and the
	 * assertion cannot pass by enumeration order.
	 */
	it("refuses an output id produced by more than one conversation", async () => {
		const dirB = await conversation("acp-b", "session-b");
		const dirA = await conversation("acp-a", "session-a");
		await fs.writeFile(path.join(dirB, "Reviewer.md"), "B's report");
		await fs.writeFile(path.join(dirA, "Reviewer.md"), "A's report");

		const resolve = new AgentProtocolHandler().resolve(new URL("agent://Reviewer") as never);

		await expect(resolve).rejects.toThrow(/Ambiguous agent output: Reviewer/);
		await expect(resolve).rejects.toThrow(/A's report|acp-a/);
	});

	/**
	 * The other direction, so refusal cannot be mistaken for a fix that broke
	 * lookup: an id only one conversation produced still resolves, even with a
	 * second conversation registered ahead of it.
	 */
	it("still resolves an id only one conversation produced", async () => {
		await conversation("acp-b", "session-b");
		const dirA = await conversation("acp-a", "session-a");
		await fs.writeFile(path.join(dirA, "OnlyA.md"), "A's unique report");

		const resource = await new AgentProtocolHandler().resolve(new URL("agent://OnlyA") as never);

		expect(resource.content).toBe("A's unique report");
	});
});
