/**
 * What the local-cli suites run the real backend with: a credential store, a harness whose local
 * command runs a script from a probe tree instead of an agent, and a registry holding only it.
 */
import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { HarnessAdapter, HarnessLookup } from "../../../engine/contracts";

/** A store with the model provider's credential, another provider's, and a cached usage report. */
export function writeCredentials(file: string): void {
	const db = new Database(file);
	try {
		db.run(
			"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL)",
		);
		db.run("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT)");
		db.run(
			"INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('probe', 'oauth', '{\"access\":\"not-a-real-token\"}')",
		);
		db.run(
			"INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('other', 'api_key', '{\"key\":\"not-a-real-key\"}')",
		);
		db.run("INSERT INTO cache (key, value) VALUES ('usage', 'cached usage report')");
	} finally {
		db.close();
	}
}

/** A harness whose local command runs `<build>/<script> <instruction>` with the runner's Bun. */
export function probeHarness(tree: string, script: string): HarnessAdapter {
	return {
		id: "probe",
		displayName: "Probe",
		description: "reports what a trial can reach",
		flags: [],
		defaultModel: null,
		capabilities: { replay: false, compaction: false, armAttachments: false, promptOverrides: false, builds: true },
		backends: { "local-cli": {} },
		preflight: async () => ({ ok: true }),
		stageAssets() {},
		localCommand: context => ({
			command: process.execPath,
			args: [path.join(context.build ?? tree, script), context.instruction],
			env: { VEYYON_CODING_AGENT_DIR: context.agentDir, PROBE_FROM_HARNESS: "set" },
			readable: [context.build ?? tree, path.dirname(process.execPath)],
		}),
	};
}

export function lookup(harness: HarnessAdapter): HarnessLookup {
	return {
		get: id => (id === harness.id ? harness : undefined),
		require: id => {
			if (id !== harness.id) throw new Error(`no harness ${id}`);
			return harness;
		},
		list: () => [harness],
		ids: () => [harness.id],
	};
}
