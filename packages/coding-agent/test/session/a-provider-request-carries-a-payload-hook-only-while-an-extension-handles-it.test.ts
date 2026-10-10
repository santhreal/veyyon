/**
 * A provider handed any `onPayload` serializes the request body, parses a copy for the hook and
 * serializes the hook's result again. On a long transcript that is the most expensive step of
 * building a request, paid every turn.
 *
 * THE DEFECT. The session's extension hook (`before_provider_request`) was installed on every
 * request whether or not an extension listened, so every turn of every session paid the copy and
 * the second serialization for a hook that returned its input.
 *
 * THE CLASS. A request reaches the provider with an `onPayload` only when something will act on the
 * payload: an extension handling `before_provider_request`, a request-level hook, or secret
 * redaction. This drives the real `createAgentSession` and asserts the options the provider
 * received, on the main turn and on a direct side request, with no listener and with one, including
 * a listener the extension registers after the session started.
 *
 * NOT COVERED. The advisor and branch-summary seams resolve the same `payloadHook`; their wiring is
 * pinned by `advisor-provider-options-parity.test.ts`, not here.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SimpleStreamOptions } from "@veyyon/ai";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const MOCK_API_SOURCE = "provider-request-payload-hook";

interface Drive {
	session: AgentSession;
	/** The options the provider received on each main-turn request. */
	turnOptions: () => (SimpleStreamOptions | undefined)[];
	dispose: () => Promise<void>;
}

const open: Drive[] = [];

afterEach(async () => {
	for (const drive of open.splice(0)) await drive.dispose();
	unregisterCustomApis(MOCK_API_SOURCE);
});

async function startSession(extension?: ExtensionFactory): Promise<Drive> {
	const tempDir = TempDir.createSync("veyyon-payload-hook-");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(MOCK_API_SOURCE);
	const model = createMockModel({ handler: { content: ["done"] } });
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({ "secrets.enabled": false, "compaction.enabled": false }),
		model,
		disableExtensionDiscovery: true,
		extensions: extension ? [extension] : [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
	});
	const drive: Drive = {
		session,
		turnOptions: () => model.calls.map(call => call.options),
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		},
	};
	open.push(drive);
	return drive;
}

async function runTurn(drive: Drive): Promise<SimpleStreamOptions | undefined> {
	await drive.session.prompt("hello");
	await drive.session.waitForIdle();
	const options = drive.turnOptions();
	return options[options.length - 1];
}

const markPayload: ExtensionFactory = pi => {
	pi.on("before_provider_request", event => ({ ...(event.payload as Record<string, unknown>), marked: true }));
};

describe("a provider request's payload hook", () => {
	it("is absent on the main turn and on a side request while no extension handles the event", async () => {
		const drive = await startSession();

		const turn = await runTurn(drive);
		const side = await drive.session.prepareSimpleStreamOptions({ apiKey: "unused" });

		expect(drive.turnOptions()).toHaveLength(1);
		expect(turn?.onPayload).toBeUndefined();
		expect(side.onPayload).toBeUndefined();
	});

	it("runs the extension's handler on the main turn and on a side request", async () => {
		const drive = await startSession(markPayload);

		const turn = await runTurn(drive);
		const side = await drive.session.prepareSimpleStreamOptions({ apiKey: "unused" });

		expect(await turn?.onPayload?.({ body: 1 })).toEqual({ body: 1, marked: true });
		expect(await side.onPayload?.({ body: 2 })).toEqual({ body: 2, marked: true });
	});

	it("starts running once an extension registers a handler after the session started", async () => {
		let register: (() => void) | undefined;
		const drive = await startSession(pi => {
			register = () => markPayload(pi);
		});

		expect((await runTurn(drive))?.onPayload).toBeUndefined();
		register?.();
		const turn = await runTurn(drive);

		expect(await turn?.onPayload?.({ body: 3 })).toEqual({ body: 3, marked: true });
	});
});
