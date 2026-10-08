/**
 * A spawned agent's transcript is reached through the session that spawned it, never listed as a
 * session of its own.
 *
 * WHY THIS SUITE EXISTS. An agent transcript is a full session file with the same header a top-level
 * session writes, and the all-projects listing globbed `**\/*.jsonl` under the sessions root. Every
 * agent a session had ever run appeared in the `/resume` and `--resume` pickers (all-projects view)
 * and in the ACP session list beside the sessions that spawned them, outnumbering them several to one.
 *
 * THE CLASS THIS CLOSES is any place an agent transcript is written that the listing reads as a
 * session. Each placement the writers use is seeded through the real `SessionManager.open` the agent
 * executor calls, at the path the writer derives: the parent's artifacts directory, an agent nested
 * under another agent, and both orphan forms a parent with no file produces. The sweep reads the
 * lists through `SessionManager.listAll`, which both pickers and ACP call, and `SessionManager.list`,
 * the per-project view. The negative control: an explicit `--resume <agent id>` still resolves the
 * agent's transcript, which the listing change must not take away.
 *
 * WHAT IT DOES NOT CATCH: a new writer that places a transcript at bucket depth under a directory name
 * that is neither a project bucket nor the orphan prefix. The listing identifies top-level sessions by
 * layout, so such a writer is listed until it uses a known placement.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveResumableSession } from "@veyyon/kernel/session/session-listing";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	captureDirOverrides,
	type DirOverridesSnapshot,
	getSessionsDir,
	restoreDirOverrides,
} from "@veyyon/utils/dirs";
import { ORPHAN_AGENT_TRANSCRIPT_PREFIX, sessionFileName } from "@veyyon/utils/session-file";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { makeAssistantMessage } from "../session-manager/helpers";

let isolated: IsolatedConfigRoot;
let snapshot: DirOverridesSnapshot;
let cwd: string;

/** Write a transcript at `file` the way the agent executor opens one, and return its session id. */
async function writeAgentTranscript(file: string, task: string): Promise<string> {
	const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: cwd, suppressBreadcrumb: true });
	manager.appendMessage({ role: "user", content: task, timestamp: 1 });
	manager.appendMessage(makeAssistantMessage());
	await manager.flush();
	const id = manager.getSessionId();
	await manager.close();
	return id;
}

async function writeTopLevelSession(prompt: string): Promise<SessionManager> {
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: prompt, timestamp: 1 });
	manager.appendMessage(makeAssistantMessage());
	await manager.flush();
	return manager;
}

describe("an agent transcript in the session lists", () => {
	beforeEach(() => {
		snapshot = captureDirOverrides();
		isolated = enterIsolatedConfigRoot("agent-transcripts-are-not-sessions");
		cwd = path.join(isolated.root, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		isolated.restore();
		restoreDirOverrides(snapshot);
	});

	it("lists each spawning session once and none of its agents, from every placement a writer uses", async () => {
		const parent = await writeTopLevelSession("the parent session");
		const parentFile = parent.getSessionFile();
		const artifactsDir = parent.getArtifactsDir();
		if (!parentFile || !artifactsDir) throw new Error("the parent session was not persisted");
		const other = await writeTopLevelSession("a second session");
		const otherFile = other.getSessionFile();
		if (!otherFile) throw new Error("the second session was not persisted");

		const sessionsRoot = getSessionsDir();
		const placements: Record<string, string> = {
			"in the parent's artifacts dir": path.join(artifactsDir, sessionFileName("Explorer")),
			"nested under another agent": path.join(artifactsDir, "Explorer", sessionFileName("Explorer.Reader")),
			"orphaned by a fileless task parent": path.join(
				sessionsRoot,
				`${ORPHAN_AGENT_TRANSCRIPT_PREFIX}0123456789`,
				sessionFileName("Worker"),
			),
			"orphaned by a direct in-process run": path.join(
				sessionsRoot,
				sessionFileName(`${ORPHAN_AGENT_TRANSCRIPT_PREFIX}Runner`),
			),
		};
		const agentIds: Record<string, string> = {};
		for (const [placement, file] of Object.entries(placements)) {
			agentIds[placement] = await writeAgentTranscript(file, `agent task ${placement}`);
			expect(fs.existsSync(file), placement).toBeTrue();
		}
		await parent.close();
		await other.close();

		const listed = (await SessionManager.listAll()).map(session => session.path).sort();
		expect(listed).toEqual([parentFile, otherFile].sort());

		const projectListed = (await SessionManager.list(cwd)).map(session => session.path).sort();
		expect(projectListed).toEqual([parentFile, otherFile].sort());

		// Negative control: an agent's id still resumes its transcript, from any directory.
		const elsewhere = path.join(isolated.root, "elsewhere");
		fs.mkdirSync(elsewhere, { recursive: true });
		for (const [placement, file] of Object.entries(placements)) {
			const match = await resolveResumableSession(agentIds[placement], elsewhere);
			expect(match?.session.path, placement).toBe(file);
		}
	});
});
