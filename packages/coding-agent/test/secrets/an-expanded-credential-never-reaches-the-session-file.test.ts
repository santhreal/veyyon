/**
 * The arguments a tool actually ran with must be persisted redacted, not expanded.
 *
 * THE DESIGN. A placeholder is expanded at the last possible moment. `transformToolCallArguments`
 * turns `#GITHUB_TOKEN#` into the credential on its way into the tool, so the tool gets something
 * that works while the model, the provider and the transcript it replays only ever hold the
 * placeholder. Everything downstream of that expansion holds plaintext and has to be treated as
 * such.
 *
 * THE BUG. `#recordToolExecutionStart` persisted `summarizeToolArguments(event.args)` verbatim, and
 * `event.args` are post-expansion. A `printf '%s' '#DOGFOOD_HASH#' | sha256sum` in a live drive was
 * written to the session JSONL as `printf '%s' '<the real credential>' | sha256sum`. That put the
 * plaintext credential in the same directory as the encrypted vault, in a file that `/share`,
 * `/export` and `/dump` read, that backups copy, and that lands in bug reports. The entry exists
 * only to render one line of a resume warning ("a tool was still running when the process died"),
 * so it never needed the expanded form at all. The `intent` goes through the same redactor because
 * the model can quote an argument back into it.
 *
 * WHAT IS ASSERTED. The projection redacts, and redacts BEFORE it truncates, which is the ordering
 * that decides whether a value straddling the 200-character cap leaves a readable prefix behind.
 * Then the whole path end to end: emit a real `tool_execution_start` through the agent the way
 * cursor mode does, read the session file off disk as bytes, and assert the credential is not in
 * it and the placeholder is. The disable case is covered too, because redaction here reads the live
 * redaction authority rather than the expansion authority, and the expansion authority is exactly
 * what a `/secret disable` takes away.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import {
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@veyyon/coding-agent/session/exit-diagnostics";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

const A_VALUE = "expanded-credential-never-persisted-24680";
const getConfigRoot = useIsolatedConfigRoot();

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("expanded-credential-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

describe("summarizeToolArguments, the projection that gets persisted", () => {
	/** The plain case: the redactor a persisting caller passes is applied to `command`. */
	it("rewrites a credential in the command through the redactor", () => {
		const summary = summarizeToolArguments({ command: `curl -H "Authorization: Bearer ${A_VALUE}"` }, text =>
			text.replaceAll(A_VALUE, "#A_TOKEN#"),
		);
		expect(summary?.command).toBe('curl -H "Authorization: Bearer #A_TOKEN#"');
	});

	/** `path` is the other persisted field, and a credential can be a path segment. */
	it("rewrites a credential in the path through the redactor", () => {
		const summary = summarizeToolArguments({ path: `/tmp/${A_VALUE}/config.json` }, text =>
			text.replaceAll(A_VALUE, "#A_TOKEN#"),
		);
		expect(summary?.path).toBe("/tmp/#A_TOKEN#/config.json");
	});

	/**
	 * The ordering that matters.
	 *
	 * Truncation cuts at 200 characters. With the value placed so that it straddles that cap, a
	 * truncate-then-redact implementation keeps whatever fell before the cut: a readable 20-character
	 * prefix of a live credential, which is enough to recognize it and, for many token formats,
	 * enough to identify the account. Redacting first means the cut can only ever land inside a
	 * placeholder.
	 */
	it("redacts before it truncates, so a value straddling the cap leaves no prefix", () => {
		const lead = "x".repeat(185);
		const summary = summarizeToolArguments({ command: `${lead}${A_VALUE}${"y".repeat(50)}` }, text =>
			text.replaceAll(A_VALUE, "#A_TOKEN#"),
		);
		expect(summary?.command).toContain("#A_TOKEN#");
		expect(summary?.command).not.toContain(A_VALUE.slice(0, 15));
		expect(summary?.command?.length).toBeLessThanOrEqual(201);
	});

	/** Truncation still happens. Redaction is added to the projection, it does not replace it. */
	it("still truncates a long command after redacting", () => {
		const summary = summarizeToolArguments({ command: "z".repeat(5000) }, text => text);
		expect(summary?.command).toBe(`${"z".repeat(200)}…`);
	});

	/**
	 * The read-back path passes no redactor on purpose: `readToolExecutionStart` re-projects a
	 * legacy entry that is already on disk, where there is nothing left to protect and rewriting
	 * would only make the resume warning disagree with the file.
	 */
	it("leaves the text alone when no redactor is supplied", () => {
		const summary = summarizeToolArguments({ command: `echo ${A_VALUE}` });
		expect(summary?.command).toBe(`echo ${A_VALUE}`);
	});

	/** Nothing to render means no `args` key at all, rather than an empty object in every entry. */
	it("returns undefined when the arguments carry neither command nor path", () => {
		expect(summarizeToolArguments({ pattern: "x", limit: 3 }, text => text)).toBeUndefined();
		expect(summarizeToolArguments({ command: "" }, text => text)).toBeUndefined();
		expect(summarizeToolArguments("not an object", text => text)).toBeUndefined();
		expect(summarizeToolArguments(undefined, text => text)).toBeUndefined();
	});
});

interface Fixture {
	root: TempDir;
	session: AgentSession;
	settings: Settings;
	sessionFile: string;
}

async function createFixture(): Promise<Fixture> {
	const root = TempDir.createSync("expanded-credential-");
	const project = path.resolve(root.join("project"));
	const agentDir = path.resolve(root.join("agent"));
	const sessionDir = path.resolve(root.join("sessions"));
	await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(sessionDir, { recursive: true })]);
	const vault = new SecretVault({
		globalConfigRoot: getConfigRoot(),
		profileDir: agentDir,
		projectDir: path.join(project, ".veyyon"),
	});
	await vault.add({ name: "A_TOKEN", value: A_VALUE, scope: "project" });
	const settings = Settings.isolated();
	settings.set("secrets.enabled", true);
	const sessionManager = SessionManager.create(project, sessionDir);
	const { session } = await createAgentSession({
		cwd: project,
		agentDir,
		sessionManager,
		settings,
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
	await session.refreshSecrets();
	return { root, session, settings, sessionFile: sessionManager.getSessionFile() ?? "" };
}

async function dispose(fixture: Fixture): Promise<void> {
	await fixture.session.dispose();
	await fixture.root.remove();
}

/** Emit the event the way cursor mode does, through the agent, so the real recording path runs. */
function emitExpandedToolStart(session: AgentSession, command: string, intent?: string): void {
	session.agent.emitExternalEvent({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "bash",
		args: { command },
		...(intent === undefined ? {} : { intent }),
	});
}

function persistedToolStart(session: AgentSession): Record<string, unknown> | undefined {
	const entry = session.sessionManager
		.getEntries()
		.find(candidate => candidate.type === "custom" && candidate.customType === TOOL_EXECUTION_START_CUSTOM_TYPE);
	return entry && entry.type === "custom" ? (entry.data as Record<string, unknown>) : undefined;
}

describe("a tool_execution_start recorded while secrets are live", () => {
	/**
	 * The exact leak from the live drive, end to end. The bytes on disk are what is asserted, not
	 * the in-memory entry, because the file is what `/share`, a backup and a bug report carry.
	 */
	it("persists the placeholder and never the credential", async () => {
		const fixture = await createFixture();
		try {
			expect(fixture.session.obfuscator?.obfuscate(A_VALUE)).toBe("#A_TOKEN#");
			emitExpandedToolStart(fixture.session, `printf '%s' '${A_VALUE}' | sha256sum`);
			await fixture.session.sessionManager.ensureOnDisk();

			const data = persistedToolStart(fixture.session);
			expect(data).toBeDefined();
			expect((data?.args as Record<string, unknown> | undefined)?.command).toBe(
				"printf '%s' '#A_TOKEN#' | sha256sum",
			);

			const onDisk = await fs.readFile(fixture.sessionFile, "utf8");
			expect(onDisk).not.toContain(A_VALUE);
			expect(onDisk).toContain("#A_TOKEN#");
		} finally {
			await dispose(fixture);
		}
	});

	/** The intent is model-authored text and can quote an argument, so it takes the same redactor. */
	it("redacts a credential the model quoted into the intent", async () => {
		const fixture = await createFixture();
		try {
			emitExpandedToolStart(fixture.session, "echo hi", `hash ${A_VALUE} for the user`);
			await fixture.session.sessionManager.ensureOnDisk();

			expect(persistedToolStart(fixture.session)?.intent).toBe("hash #A_TOKEN# for the user");
			expect(await fs.readFile(fixture.sessionFile, "utf8")).not.toContain(A_VALUE);
		} finally {
			await dispose(fixture);
		}
	});

	/**
	 * A path argument reaches the file through the same projection. Covered separately from the
	 * command because the two fields are independent branches of `summarizeToolArguments` and a fix
	 * applied to one of them would still pass a command-only test.
	 */
	it("redacts a credential used as a path", async () => {
		const fixture = await createFixture();
		try {
			fixture.session.agent.emitExternalEvent({
				type: "tool_execution_start",
				toolCallId: "call-2",
				toolName: "read",
				args: { path: `/srv/${A_VALUE}/id_rsa` },
			});
			await fixture.session.sessionManager.ensureOnDisk();

			expect((persistedToolStart(fixture.session)?.args as Record<string, unknown> | undefined)?.path).toBe(
				"/srv/#A_TOKEN#/id_rsa",
			);
			expect(await fs.readFile(fixture.sessionFile, "utf8")).not.toContain(A_VALUE);
		} finally {
			await dispose(fixture);
		}
	});

	/**
	 * The reason this reads the redaction authority and not `session.obfuscator`.
	 *
	 * `/secret disable` revokes expansion, so `session.obfuscator` becomes undefined. A recording
	 * path that read it would stop redacting at exactly the moment the operator asked for less
	 * exposure. The tombstone on the redaction obfuscator keeps the value hidden, and an event still
	 * in flight when the disable lands must be caught by it.
	 */
	it("keeps redacting after secrets are disabled mid-session", async () => {
		const fixture = await createFixture();
		try {
			fixture.settings.set("secrets.enabled", false);
			await fixture.session.refreshSecrets();
			expect(fixture.session.obfuscator).toBeUndefined();
			expect(fixture.session.providerRedactor).toBeDefined();

			emitExpandedToolStart(fixture.session, `curl -u ${A_VALUE} https://example.invalid`);
			await fixture.session.sessionManager.ensureOnDisk();

			const command = (persistedToolStart(fixture.session)?.args as Record<string, unknown> | undefined)?.command;
			expect(typeof command).toBe("string");
			expect(command).not.toContain(A_VALUE);
			expect(await fs.readFile(fixture.sessionFile, "utf8")).not.toContain(A_VALUE);
		} finally {
			await dispose(fixture);
		}
	});

	/** With no secrets configured the projection is the identity it always was. */
	it("leaves an ordinary command untouched", async () => {
		const fixture = await createFixture();
		try {
			emitExpandedToolStart(fixture.session, "ls -la /etc");
			await fixture.session.sessionManager.ensureOnDisk();
			expect((persistedToolStart(fixture.session)?.args as Record<string, unknown> | undefined)?.command).toBe(
				"ls -la /etc",
			);
		} finally {
			await dispose(fixture);
		}
	});
});

describe("the redaction authority the rest of the app reads", () => {
	/**
	 * `providerRedactor` is the live one and `obfuscator` is the expansion one. Any consumer that
	 * hides a value has to hold the first. This pins the difference that makes the distinction worth
	 * having: after a disable they disagree, and the redaction one is the one still working.
	 */
	it("outlives the expansion authority", async () => {
		const fixture = await createFixture();
		try {
			expect(fixture.session.providerRedactor).toBe(fixture.session.obfuscator);

			fixture.settings.set("secrets.enabled", false);
			await fixture.session.refreshSecrets();

			expect(fixture.session.obfuscator).toBeUndefined();
			expect(fixture.session.providerRedactor?.hasSecrets()).toBe(true);
			expect(fixture.session.obfuscateProviderText(`token=${A_VALUE}`)).not.toContain(A_VALUE);
		} finally {
			await dispose(fixture);
		}
	});

	/**
	 * `/share` uploads the session to a public URL, so it is the seam where reading the expansion
	 * authority fails open and outward. It was passing `session.obfuscator`, which meant
	 * `share.redactSecrets` silently did nothing once expansion had been revoked. Asserted at the
	 * source because the alternative is performing a real upload.
	 */
	it("is what the share command hands to the snapshot builder", async () => {
		const sources = [
			path.resolve(import.meta.dir, "../../src/modes/controllers/command-controller.ts"),
			path.resolve(import.meta.dir, "../../src/slash-commands/builtin-registry.ts"),
		];
		for (const source of sources) {
			const text = await fs.readFile(source, "utf8");
			expect(text).toContain("share.redactSecrets");
			expect(text).toContain("providerRedactor");
			expect(text).not.toMatch(/share\.redactSecrets"\) \? [^\n]*\.session\.obfuscator /);
		}
	});

	/**
	 * The structural lock. Every one of these seams sends text to a provider, and every one of them
	 * used to reach for the expansion authority. `obfuscateProviderText` is the single owner now, so
	 * a new copy of the old expression is what this catches.
	 */
	it("is not bypassed by a direct obfuscate call on any provider-bound seam", async () => {
		const sources = [
			"../../src/modes/controllers/event-controller.ts",
			"../../src/modes/controllers/input-controller.ts",
			"../../src/hindsight/state.ts",
			"../../src/mnemopi/backend.ts",
		];
		for (const relative of sources) {
			const text = await fs.readFile(path.resolve(import.meta.dir, relative), "utf8");
			const offenders = text
				.split("\n")
				.filter(line => /\.obfuscator\?\.obfuscate\(/.test(line) || /\.obfuscator\.obfuscate\(/.test(line));
			expect(offenders).toEqual([]);
		}
	});
});
