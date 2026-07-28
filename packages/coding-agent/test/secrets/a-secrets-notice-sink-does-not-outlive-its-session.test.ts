/**
 * The secrets notice sink is a process global, so its lifetime has to be managed by hand.
 *
 * WHY THIS EXISTS. A few secrets conditions cannot be reported by returning: a key directory that
 * was left group-writable and has been tightened, a vault still sealed under a superseded binding.
 * They fire deep inside `pinKeyRoot` and the vault read path, reached from every `SecretVault`
 * method, so they are raised through a module-level sink rather than a parameter threaded into a
 * dozen signatures. That makes the sink shared state, and shared state that closes over ONE
 * session's `OperatorNotices` will keep that session's notices reachable after it is gone and post
 * later conditions into a channel nothing renders. `attachFaultSink` next to it in `sdk.ts` already
 * had this rule and a comment explaining it; this one was added without the detach.
 *
 * WHAT IS ASSERTED. The module contract on its own (deliver, replace, detach, never throw when
 * absent), then the wiring: a live session receives a condition, and the same condition raised
 * after that session is disposed reaches nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { noteSecretsCondition, setSecretsNoticeSink } from "@veyyon/coding-agent/secrets/notices";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

// Redirects the config root, so nothing here can touch the operator's real ~/.veyyon.
useIsolatedConfigRoot();

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("secrets-notice-sink-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

// Every test in this file installs a sink. Leaving one attached would leak into whatever runs next
// in the same process, which is the failure the file is about.
afterEach(() => setSecretsNoticeSink(undefined));

describe("the secrets notice sink module", () => {
	/** The plain case: an installed sink receives the message verbatim. */
	it("delivers a condition to the installed sink", () => {
		const seen: string[] = [];
		setSecretsNoticeSink(message => seen.push(message));

		noteSecretsCondition("the key directory was tightened");

		expect(seen).toEqual(["the key directory was tightened"]);
	});

	/**
	 * With no sink there is nothing to deliver to, and a condition raised then must not become an
	 * exception inside whatever key or vault operation raised it. Losing a notice is acceptable;
	 * failing a vault read because nobody was listening is not.
	 */
	it("does nothing and throws nothing when no sink is installed", () => {
		expect(() => noteSecretsCondition("nobody is listening")).not.toThrow();
	});

	/** Detaching stops delivery, which is the whole point of the handle `sdk.ts` holds. */
	it("stops delivering once detached", () => {
		const seen: string[] = [];
		setSecretsNoticeSink(message => seen.push(message));
		setSecretsNoticeSink(undefined);

		noteSecretsCondition("after detach");

		expect(seen).toEqual([]);
	});

	/** A replacement takes over completely, so two sessions cannot both receive one condition. */
	it("replaces rather than accumulates sinks", () => {
		const first: string[] = [];
		const second: string[] = [];
		setSecretsNoticeSink(message => first.push(message));
		setSecretsNoticeSink(message => second.push(message));

		noteSecretsCondition("only the second");

		expect(first).toEqual([]);
		expect(second).toEqual(["only the second"]);
	});
});

describe("the sink a session installs", () => {
	/**
	 * The regression. A disposed session's notices must not still be the destination: the sink
	 * closes over them, so without an explicit detach the object stays reachable and every later
	 * condition in the process is posted to a surface that no longer exists.
	 */
	it("is detached when the session is disposed", async () => {
		const root = TempDir.createSync("secrets-notice-sink-");
		try {
			const project = path.resolve(root.join("project"));
			const agentDir = path.resolve(root.join("agent"));
			await fs.mkdir(project, { recursive: true });
			const operatorNotices = new OperatorNotices();
			const { session } = await createAgentSession({
				cwd: project,
				agentDir,
				sessionManager: SessionManager.inMemory(project),
				settings: Settings.isolated(),
				modelRegistry,
				operatorNotices,
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});

			noteSecretsCondition("while the session is alive");
			const delivered = operatorNotices.pending().filter(notice => notice.source === "secrets");
			expect(delivered.map(notice => notice.text)).toContain("while the session is alive");

			await session.dispose();
			noteSecretsCondition("after the session is gone");

			const after = operatorNotices.pending().filter(notice => notice.source === "secrets");
			expect(after.map(notice => notice.text)).not.toContain("after the session is gone");
		} finally {
			await root.remove();
		}
	});
});
