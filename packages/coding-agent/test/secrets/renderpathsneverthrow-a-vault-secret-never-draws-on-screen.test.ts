/**
 * A vault-backed credential must never be drawn on screen, on any display path.
 *
 * THE LEAK THIS LOCKS OUT: `AgentSession`'s display expander restored a stored credential back
 * into the text it was about to render. The model only ever wrote the placeholder (it is never
 * handed the value), so every occurrence of the cleartext on screen was veyyon expanding its own
 * redaction locally. It reached the operator's terminal and scrollback through model-authored
 * prose AND through a tool call's `arguments`, on `message_start`, `message_end`, `turn_end` and
 * `agent_end` alike, because the expander ran per string and did not care which field it was in.
 *
 * Nothing went outbound: the session file keeps the placeholder and the provider boundary redacts
 * independently. This is a screen and scrollback exposure, and it directly contradicts what
 * `/secret` promises, which is that a stored value is substituted into commands and never shown.
 *
 * WHY IT WAS INVISIBLE FOR SO LONG: restoring a placeholder for display is CORRECT for a value
 * whose obfuscation only ever existed to keep it away from the provider. It is wrong for a value
 * the operator stored in the vault precisely so it would never be displayed, and the expander had
 * no way to tell the two apart. Note that only MODEL-AUTHORED text reaches it at all
 * (`mapAgentMessageStrings` walks assistant content and the LLM-written summaries; user, developer
 * and tool-result messages are never walked), so there is no operator-typed value here whose
 * restoration this protects.
 *
 * If this regresses: a stored credential is printed into the terminal of anyone running a session
 * that mentions it, lands in their scrollback, and travels into any HTML export, `/share` payload
 * or screen recording made afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

const STORED_NAME = "SCREEN_TOKEN";
const STORED_PLACEHOLDER = `#${STORED_NAME}#`;
const STORED_VALUE = "vault-value-never-draw-me-97531";
const getConfigRoot = useIsolatedConfigRoot();

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("renderpaths-screen-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

interface ScreenFixture {
	root: TempDir;
	vault: SecretVault;
	settings: Settings;
	session: AgentSession;
}

/**
 * @param options.configRegexPattern Also declare a `secrets.yml` REGEX entry in the project, which
 *   is the one origin/type combination that stays restorable on screen. Used to prove the fix
 *   withholds stored credentials without disabling display restoration wholesale.
 */
async function createScreenFixture(options: { configRegexPattern?: string } = {}): Promise<ScreenFixture> {
	const root = TempDir.createSync("renderpaths-screen-");
	const project = path.resolve(root.join("project"));
	const agentDir = path.resolve(root.join("agent"));
	await fs.mkdir(path.join(project, ".veyyon"), { recursive: true });
	if (options.configRegexPattern !== undefined) {
		await Bun.write(
			path.join(project, ".veyyon", "secrets.yml"),
			`- type: regex\n  content: "${options.configRegexPattern}"\n`,
		);
	}
	const locations: VaultLocations = {
		globalConfigRoot: getConfigRoot(),
		profileDir: agentDir,
		projectDir: path.join(project, ".veyyon"),
	};
	const vault = new SecretVault(locations);
	await vault.add({ name: STORED_NAME, value: STORED_VALUE, scope: "project" });
	const settings = Settings.isolated();
	const { session } = await createAgentSession({
		cwd: project,
		agentDir,
		sessionManager: SessionManager.inMemory(project),
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
	settings.set("secrets.enabled", true);
	await session.refreshSecrets({ refreshPrompt: false });
	// The runtime really did load the vault entry: the value maps to its placeholder. Without
	// this the whole suite would pass by loading no secrets at all.
	expect(session.obfuscator?.obfuscate(STORED_VALUE)).toBe(STORED_PLACEHOLDER);
	return { root, vault, settings, session };
}

async function disposeScreenFixture(fixture: ScreenFixture): Promise<void> {
	await fixture.session.dispose();
	await fixture.root.remove();
}

/**
 * Every location in `value` holding `needle`, as dotted paths, never the needle itself.
 *
 * Deliberately structure-blind rather than checking the fields the leak was reported in: a field
 * added to assistant content later is swept into the same per-string walk automatically, and this
 * catches that without anyone remembering to extend the assertion.
 */
function leakPaths(value: unknown, needle: string, trail = "$"): string[] {
	if (typeof value === "string") return value.includes(needle) ? [trail] : [];
	if (Array.isArray(value)) return value.flatMap((item, index) => leakPaths(item, needle, `${trail}[${index}]`));
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([key, item]) => leakPaths(item, needle, `${trail}.${key}`));
	}
	return [];
}

/** Model-authored content carrying the placeholder in prose, in arguments, and in the intent. */
function assistantContentMentioningTheSecret(): AssistantMessage["content"] {
	return [
		{ type: "text", text: `I will write ${STORED_PLACEHOLDER} to the digest file.` },
		{
			type: "toolCall",
			id: "call_screen_1",
			name: "bash",
			intent: `hashing ${STORED_PLACEHOLDER}`,
			arguments: { command: `printf %s "${STORED_PLACEHOLDER}" | sha256sum`, note: `spends ${STORED_PLACEHOLDER}` },
		},
	] as AssistantMessage["content"];
}

function assistantSaying(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return { role: "assistant", content, timestamp } as unknown as AssistantMessage;
}

describe("a vault-backed secret never draws on screen", () => {
	/**
	 * The reported shape: the model's own prose naming the placeholder. This is where the operator
	 * actually saw the credential, and it is the one surface where restoring for display never had
	 * a rationale, because the model wrote the placeholder and never knew the value.
	 */
	it("leaves the placeholder standing in model prose", async () => {
		const fixture = await createScreenFixture();
		try {
			const shown = fixture.session.displayAssistantContent([
				{ type: "text", text: `I will write ${STORED_PLACEHOLDER} to the digest file.` },
			]);
			expect(leakPaths(shown, STORED_VALUE)).toEqual([]);
			expect(leakPaths(shown, STORED_PLACEHOLDER)).toEqual(["$[0].text"]);
		} finally {
			await disposeScreenFixture(fixture);
		}
	});

	/**
	 * The same string function walks a tool call's `arguments`, `intent` and `rawBlock`
	 * unconditionally, so the credential reached the screen through the rendered call as well as
	 * through prose. Asserted structure-blind: nowhere in the returned content, at any depth.
	 */
	it("leaves the placeholder standing in tool-call arguments and intent", async () => {
		const fixture = await createScreenFixture();
		try {
			const shown = fixture.session.displayAssistantContent(assistantContentMentioningTheSecret());
			expect(leakPaths(shown, STORED_VALUE)).toEqual([]);
			expect(leakPaths(shown, STORED_PLACEHOLDER).sort()).toEqual([
				"$[0].text",
				"$[1].arguments.command",
				"$[1].arguments.note",
				"$[1].intent",
			]);
		} finally {
			await disposeScreenFixture(fixture);
		}
	});

	/** The interactive working line renders the intent on its own, through its own pass. */
	it("leaves the placeholder standing in a tool intent rendered on its own", async () => {
		const fixture = await createScreenFixture();
		try {
			expect(fixture.session.displayToolIntent(`hashing ${STORED_PLACEHOLDER}`)).toBe(
				`hashing ${STORED_PLACEHOLDER}`,
			);
		} finally {
			await disposeScreenFixture(fixture);
		}
	});

	/**
	 * Both transcript builders: one feeds every TUI repaint, the other is what the constructor and
	 * every post-compaction rebuild read. A leak here paints the credential on a redraw the
	 * operator never asked for.
	 */
	it("leaves the placeholder standing in both rendered transcripts", async () => {
		const fixture = await createScreenFixture();
		try {
			fixture.session.sessionManager.appendMessage(assistantSaying(assistantContentMentioningTheSecret(), 1));

			const transcript = fixture.session.buildTranscriptSessionContext();
			const display = fixture.session.buildDisplaySessionContext();

			expect(leakPaths(transcript.messages, STORED_VALUE)).toEqual([]);
			expect(leakPaths(display.messages, STORED_VALUE)).toEqual([]);
			// Still rendering the message at all, rather than passing by dropping content.
			expect(leakPaths(transcript.messages, STORED_PLACEHOLDER).length).toBeGreaterThan(0);
			expect(leakPaths(display.messages, STORED_PLACEHOLDER).length).toBeGreaterThan(0);
		} finally {
			await disposeScreenFixture(fixture);
		}
	});

	/**
	 * Adversarial: the value must not surface even when the model wraps it in shapes a naive
	 * per-field fix would miss, and even when the same string carries several placeholders.
	 */
	it("leaves the placeholder standing in nested arguments and repeated mentions", async () => {
		const fixture = await createScreenFixture();
		try {
			const shown = fixture.session.displayAssistantContent([
				{
					type: "toolCall",
					id: "call_screen_2",
					name: "write",
					arguments: {
						files: [
							{ path: "a.txt", body: `${STORED_PLACEHOLDER} and ${STORED_PLACEHOLDER} again` },
							{ path: "b.txt", body: { deeply: { nested: STORED_PLACEHOLDER } } },
						],
					},
				},
			] as AssistantMessage["content"]);
			expect(leakPaths(shown, STORED_VALUE)).toEqual([]);
		} finally {
			await disposeScreenFixture(fixture);
		}
	});

	/**
	 * The boundary between the two halves of the mechanism. Withholding a value from the SCREEN
	 * must not stop redacting it for the PROVIDER: the obfuscator still maps value to placeholder,
	 * which is what keeps the credential out of a request body.
	 */
	it("still redacts the value for the provider while refusing to display it", async () => {
		const fixture = await createScreenFixture();
		try {
			expect(fixture.session.obfuscator?.obfuscate(`token ${STORED_VALUE}`)).toBe(`token ${STORED_PLACEHOLDER}`);
			const shown = fixture.session.displayAssistantContent([{ type: "text", text: `token ${STORED_PLACEHOLDER}` }]);
			expect(leakPaths(shown, STORED_VALUE)).toEqual([]);
		} finally {
			await disposeScreenFixture(fixture);
		}
	});

	/**
	 * THE OTHER DIRECTION, and the reason this fix is a carve-out rather than switching display
	 * expansion off. A `secrets.yml` REGEX entry does not hold a stored credential: it recognises a
	 * shape in text that was already flowing through, so redaction protects the provider while the
	 * screen should still show what is actually there. That combination, and only that one, stays
	 * restorable.
	 *
	 * If this regresses, the display path has been disabled wholesale rather than taught the
	 * difference, and every regex-protected value renders as an opaque `#0...#` token that no
	 * operator can decode. That failure looks like a rendering bug rather than a policy change,
	 * which is why it needs its own test rather than trusting the withholding ones above.
	 */
	it("still restores a config regex match, which is the one case that may be shown", async () => {
		const fixture = await createScreenFixture({ configRegexPattern: "ghp_[A-Za-z0-9]{20}" });
		try {
			const matched = "ghp_abcdefghij0123456789";
			// A regex mapping only exists once the value has passed through redaction, which is
			// exactly how it arises in a session: the text went out, so the map learned the value.
			const redacted = fixture.session.obfuscator?.obfuscate(`found ${matched} in config`) ?? "";
			expect(redacted).not.toContain(matched);
			const placeholder = redacted.slice("found ".length, redacted.indexOf(" in config"));
			expect(placeholder.startsWith("#")).toBe(true);

			// Same display path that withholds the vault secret restores this one.
			const shown = fixture.session.displayAssistantContent([
				{ type: "text", text: `found ${placeholder} in config` },
			]);
			expect(shown).toEqual([{ type: "text", text: `found ${matched} in config` }]);

			// And the vault secret in the SAME session is still withheld, so the carve-out is per
			// mapping rather than per session.
			const both = fixture.session.displayAssistantContent([
				{ type: "text", text: `${placeholder} and ${STORED_PLACEHOLDER}` },
			]);
			expect(leakPaths(both, STORED_VALUE)).toEqual([]);
			expect(leakPaths(both, matched)).toEqual(["$[0].text"]);
		} finally {
			await disposeScreenFixture(fixture);
		}
	});
});
