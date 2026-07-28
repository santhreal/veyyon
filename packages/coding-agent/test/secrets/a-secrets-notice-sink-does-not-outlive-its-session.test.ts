/**
 * Secrets notice registrations are process-global, so each session owns an identity-bound detach
 * token.
 *
 * WHY THIS EXISTS. A few secrets conditions cannot be reported by returning: a key directory that
 * was left group-writable and has been tightened, a vault still sealed under a superseded binding.
 * They fire deep inside `pinKeyRoot` and the vault read path, reached from every `SecretVault`
 * method, so they are raised through module-level registrations rather than a parameter threaded
 * into a dozen signatures.
 *
 * WHAT IS ASSERTED. Registrations accumulate, each detach token removes only its own sink, and two
 * overlapping SDK sessions continue independently when the earlier session is disposed. The last
 * case is the regression: a singleton setter let the second session replace the first, then let
 * either session's disposal detach the surviving session.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { attachSecretsNoticeSink, noteSecretsCondition } from "@veyyon/coding-agent/secrets/notices";
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

describe("the secrets notice sink module", () => {
	/** The plain case: an attached sink receives the message verbatim. */
	it("delivers a condition to an attached sink", () => {
		const seen: string[] = [];
		const detach = attachSecretsNoticeSink(message => seen.push(message));
		try {
			noteSecretsCondition("the key directory was tightened");
			expect(seen).toEqual(["the key directory was tightened"]);
		} finally {
			detach();
		}
	});

	/**
	 * With no sink there is nothing to deliver to, and a condition raised then must not become an
	 * exception inside whatever key or vault operation raised it. Losing a notice is acceptable;
	 * failing a vault read because nobody was listening is not.
	 */
	it("does nothing and throws nothing when no sink is installed", () => {
		expect(() => noteSecretsCondition("nobody is listening")).not.toThrow();
	});

	/**
	 * Tokens identify registrations rather than callback functions. Registering the same function
	 * twice creates two lifetimes, and either token removes only its own registration.
	 */
	it("keeps overlapping registration tokens independent", () => {
		const seen: string[] = [];
		const sharedSink = (message: string) => seen.push(message);
		const detachFirst = attachSecretsNoticeSink(sharedSink);
		const detachSecond = attachSecretsNoticeSink(sharedSink);
		try {
			noteSecretsCondition("both registrations are alive");
			detachFirst();
			detachFirst();
			noteSecretsCondition("only the second registration remains");

			expect(seen).toEqual([
				"both registrations are alive",
				"both registrations are alive",
				"only the second registration remains",
			]);
		} finally {
			detachFirst();
			detachSecond();
		}
	});
});

describe("the registrations installed by overlapping SDK sessions", () => {
	/**
	 * The regression end to end. Starting session B must not replace session A, and disposing A
	 * must remove only A's registration rather than detaching B's still-live notice surface.
	 */
	it("preserves the later session when the earlier session is disposed", async () => {
		const root = TempDir.createSync("secrets-notice-sink-");
		try {
			const projectA = path.resolve(root.join("project-a"));
			const projectB = path.resolve(root.join("project-b"));
			const agentDirA = path.resolve(root.join("agent-a"));
			const agentDirB = path.resolve(root.join("agent-b"));
			await fs.mkdir(projectA, { recursive: true });
			await fs.mkdir(projectB, { recursive: true });
			const noticesA = new OperatorNotices();
			const noticesB = new OperatorNotices();
			const common = {
				settings: Settings.isolated(),
				modelRegistry,
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			};
			const { session: sessionA } = await createAgentSession({
				...common,
				cwd: projectA,
				agentDir: agentDirA,
				sessionManager: SessionManager.inMemory(projectA),
				operatorNotices: noticesA,
			});
			const { session: sessionB } = await createAgentSession({
				...common,
				cwd: projectB,
				agentDir: agentDirB,
				sessionManager: SessionManager.inMemory(projectB),
				operatorNotices: noticesB,
			});
			try {
				noteSecretsCondition("while both sessions are alive");
				expect(noticesA.pending().map(notice => notice.text)).toContain("while both sessions are alive");
				expect(noticesB.pending().map(notice => notice.text)).toContain("while both sessions are alive");

				await sessionA.dispose();
				noteSecretsCondition("after the earlier session is gone");

				expect(noticesA.pending().map(notice => notice.text)).not.toContain("after the earlier session is gone");
				expect(noticesB.pending().map(notice => notice.text)).toContain("after the earlier session is gone");
			} finally {
				await sessionA.dispose();
				await sessionB.dispose();
			}
		} finally {
			await root.remove();
		}
	});

	/**
	 * A supplied manager predates SDK construction, so passing the notice channel only to the
	 * default-manager factory misses it. The SDK must attach its channel to the selected manager
	 * before a later transcript load discovers recoverable data loss.
	 */
	it("attaches operator notices to an externally supplied session manager", async () => {
		const root = TempDir.createSync("sdk-supplied-manager-notices-");
		try {
			const project = path.resolve(root.join("project"));
			const agentDir = path.resolve(root.join("agent"));
			const sessionDir = path.resolve(root.join("sessions"));
			await fs.mkdir(project, { recursive: true });
			const suppliedManager = SessionManager.create(project, sessionDir);
			const currentHeader = suppliedManager.getHeader();
			if (currentHeader === undefined) throw new Error("expected the supplied manager to have a session header");
			const header = JSON.stringify(currentHeader);
			const secretPayload = "DO-NOT-ECHO-SDK-ATTACHMENT-CONTENT";
			const malformedFile = path.join(sessionDir, "recoverable-malformed.jsonl");
			await fs.writeFile(
				malformedFile,
				`${header}\n${JSON.stringify({
					type: "message",
					id: "malformed",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: secretPayload,
				})}\n`,
			);
			const notices = new OperatorNotices();
			const { session } = await createAgentSession({
				cwd: project,
				agentDir,
				sessionManager: suppliedManager,
				operatorNotices: notices,
				settings: Settings.isolated(),
				modelRegistry,
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
			try {
				await suppliedManager.setSessionFile(malformedFile);

				const recovery = notices.all().filter(notice => notice.text.includes(malformedFile));
				expect(recovery).toHaveLength(1);
				expect(recovery[0]?.text).toContain("a message entry has no `message` object");
				expect(recovery[0]?.text).not.toContain(secretPayload);
			} finally {
				await session.dispose();
			}
		} finally {
			await root.remove();
		}
	});
});
