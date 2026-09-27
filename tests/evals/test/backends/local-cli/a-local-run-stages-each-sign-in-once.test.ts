/**
 * WHY: every local-cli trial copied and pruned the runner's whole credential store on its own, and a
 * trial whose access token expired mid-trial refreshed it inside its copy. A provider that rotates
 * refresh tokens then retired the token the runner's store still held, since the copy with the new
 * one was deleted with the trial: every later trial, and the runner's own sessions, failed to sign
 * in.
 *
 * The cases run two trials through one backend and assert the second signs in from the store the
 * first staged, not from a second copy of the runner's; and they drive the refresh with a real
 * credential store, recording which sign-ins are refreshed: one whose access token expires before
 * the trial would end is, one that outlives it is not, and another provider's is not.
 *
 * Not caught: whether the provider accepts the refresh, which needs its endpoint; the refresh call is
 * recorded and made to fail, which the staging tolerates.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { TempDir } from "@veyyon/utils";
import { refreshExpiringSignIns } from "../../../backends/local-cli/credentials";
import { LocalCliBackend, localTrialLayout } from "../../../backends/local-cli/main";
import { LOCAL_TRIAL_FILES } from "../../../engine/run/layout";
import { oneTrialRun, probeHarness } from "./probe-fixtures";

/** Answers with the access token of the sign-in its store holds. */
const STATES_ITS_TOKEN = `import { Database } from "bun:sqlite";
const db = new Database(process.env.VEYYON_CODING_AGENT_DIR + "/agent.db", { readonly: true });
const { data } = db.query("SELECT data FROM auth_credentials").get();
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.parse(data).access }], usage: { input: 1, output: 1 } } }));
`;

describe("a local run", () => {
	it("signs every trial in from the store it staged once", async () => {
		await using dir = await TempDir.create("@evals-local-cli-stage-once-");
		const tree = dir.join("tree");
		await fs.mkdir(tree, { recursive: true });
		await fs.writeFile(path.join(tree, "agent.ts"), STATES_ITS_TOKEN);
		const { context, cell } = oneTrialRun({
			root: dir.path(),
			suite: "stage-once-probe",
			harness: probeHarness(tree, "agent.ts"),
			build: tree,
		});
		const backend = new LocalCliBackend();
		const answer = async (repeat: number): Promise<string> => {
			const trial = { ...cell, repeat };
			await backend.runTrial(trial, context);
			const layout = localTrialLayout(context.runsDir, context.runId, trial);
			return await fs.readFile(path.join(layout.trialDir, LOCAL_TRIAL_FILES.answer), "utf8");
		};

		expect(await answer(1)).toBe("not-a-real-token");
		const source = new Database(dir.join("agent.db"));
		source.run(`UPDATE auth_credentials SET data = '{"access":"not-a-real-token-later"}' WHERE provider = 'probe'`);
		source.close();

		expect(await answer(2)).toBe("not-a-real-token");
	});
});

describe("refreshing a sign-in before it is staged", () => {
	it("refreshes the model provider's sign-ins that would expire before the trial ends, and no other", async () => {
		await using dir = await TempDir.create("@evals-local-cli-refresh-");
		const file = dir.join("agent.db");
		const now = Date.now();
		const store = await SqliteAuthCredentialStore.open(file);
		store.saveOAuth("anthropic", {
			access: "not-a-real-access",
			refresh: "not-a-real-refresh",
			expires: now + 60_000,
		});
		store.saveOAuth("openai", {
			access: "not-a-real-other",
			refresh: "not-a-real-other-refresh",
			expires: now + 60_000,
		});
		store.close();
		const refreshed: number[] = [];
		const refresh = spyOn(AuthStorage.prototype, "forceRefreshCredentialById").mockImplementation(async id => {
			refreshed.push(id);
			throw new Error("the provider is not reachable from a test");
		});
		try {
			await refreshExpiringSignIns(file, "anthropic", now + 30_000);
			expect(refreshed).toEqual([]);

			await refreshExpiringSignIns(file, "anthropic", now + 3_600_000);
			expect(refreshed).toHaveLength(1);
		} finally {
			refresh.mockRestore();
		}
	});
});
