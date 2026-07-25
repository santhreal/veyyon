/**
 * How `before_agent_start` extensions change the system prompt.
 *
 * Why this suite exists: `packages/coding-agent/examples/extensions/pirate.ts`
 * taught this API by returning `systemPromptAppend`, a field no result type has
 * and which appears nowhere in the source, so the one shipped example of
 * prompt-extension silently did nothing. The real contract is `systemPrompt`,
 * which REPLACES, and appending means returning `[...event.systemPrompt, extra]`
 * — which works only because the event hands each extension the prompt as it
 * stands after the extensions before it. That chaining had no test, so the
 * example could be wrong for as long as it was.
 *
 * The runner also accepts a bare string and wraps it. That branch existed with a
 * `string[]`-only type on the result, reading like dead code; it is now typed and
 * pinned here, because extensions are plain JavaScript loaded at runtime and
 * nothing stops one from returning a string.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { discoverAndLoadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";

/** The prompt the session would have used had no extension touched it. */
const BASE_PROMPT = ["base-one", "base-two"];

describe("before_agent_start system prompt", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	// The registry loads every bundled model in its constructor, so it is built
	// once for the file rather than per test.
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@veyyon-bas-prompt-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-bas-prompt-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	/** Writes an extension and returns a runner loaded with only this test's extensions. */
	async function runnerWith(files: Record<string, string>): Promise<ExtensionRunner> {
		for (const [name, code] of Object.entries(files)) {
			fs.writeFileSync(path.join(extensionsDir, name), code);
		}
		const loaded = await discoverAndLoadExtensions([extensionsDir], tempDir.path());
		const scoped = loaded.extensions.filter(extension => extension.path.startsWith(extensionsDir));

		expect(scoped.map(extension => path.basename(extension.path)).sort()).toEqual(Object.keys(files).sort());

		return new ExtensionRunner(scoped, loaded.runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	/** An extension appending one section the documented way. */
	function appendingExtension(section: string): string {
		return `
			export default function (pi) {
				pi.on("before_agent_start", async event => ({
					systemPrompt: [...event.systemPrompt, ${JSON.stringify(section)}],
				}));
			}
		`;
	}

	/**
	 * The append idiom the pirate example now teaches. Asserted on the exact array,
	 * not on "contains", so a runner that dropped the base prompt would fail.
	 */
	it("appends a section when the handler returns the event's prompt plus its own", async () => {
		const runner = await runnerWith({ "append.ts": appendingExtension("pirate-rules") });

		const result = await runner.emitBeforeAgentStart("prompt", undefined, BASE_PROMPT);

		expect(result?.systemPrompt).toEqual(["base-one", "base-two", "pirate-rules"]);
	});

	/**
	 * The chaining that makes appending composable: the SECOND extension has to see
	 * the first one's section in `event.systemPrompt`, or two extensions appending
	 * the documented way would silently keep only the last section.
	 */
	it("hands each extension the prompt as the previous one left it", async () => {
		const runner = await runnerWith({
			"a-first.ts": appendingExtension("from-first"),
			"b-second.ts": appendingExtension("from-second"),
		});

		const result = await runner.emitBeforeAgentStart("prompt", undefined, BASE_PROMPT);

		expect(result?.systemPrompt).toEqual(["base-one", "base-two", "from-first", "from-second"]);
	});

	/**
	 * `systemPrompt` REPLACES. This is the half the broken example got wrong: an
	 * extension that returns only its own section discards the base prompt, and
	 * that is the documented behaviour rather than a bug to soften.
	 */
	it("replaces the whole prompt when the handler returns only its own sections", async () => {
		const runner = await runnerWith({
			"replace.ts": `
				export default function (pi) {
					pi.on("before_agent_start", async () => ({ systemPrompt: ["only-this"] }));
				}
			`,
		});

		const result = await runner.emitBeforeAgentStart("prompt", undefined, BASE_PROMPT);

		expect(result?.systemPrompt).toEqual(["only-this"]);
	});

	/** A bare string is one section, not a list of characters. */
	it("wraps a string result into a one-section prompt", async () => {
		const runner = await runnerWith({
			"string.ts": `
				export default function (pi) {
					pi.on("before_agent_start", async () => ({ systemPrompt: "a-single-section" }));
				}
			`,
		});

		const result = await runner.emitBeforeAgentStart("prompt", undefined, BASE_PROMPT);

		expect(result?.systemPrompt).toEqual(["a-single-section"]);
	});

	/**
	 * A string from one extension must still be visible as an array to the next, or
	 * the documented append idiom breaks whenever it follows a string-returning
	 * extension.
	 */
	it("normalizes a string before the next extension appends to it", async () => {
		const runner = await runnerWith({
			"a-string.ts": `
				export default function (pi) {
					pi.on("before_agent_start", async () => ({ systemPrompt: "replaced" }));
				}
			`,
			"b-append.ts": appendingExtension("appended"),
		});

		const result = await runner.emitBeforeAgentStart("prompt", undefined, BASE_PROMPT);

		expect(result?.systemPrompt).toEqual(["replaced", "appended"]);
	});

	/**
	 * The name the broken example used. Kept as a test so the mistake cannot come
	 * back looking like it works: an unknown field is ignored, and the runner
	 * reports no prompt change at all, which is exactly why nobody noticed the
	 * example was inert.
	 */
	it("ignores systemPromptAppend, the field the old example invented", async () => {
		const runner = await runnerWith({
			"invented.ts": `
				export default function (pi) {
					pi.on("before_agent_start", async () => ({ systemPromptAppend: "never-applied" }));
				}
			`,
		});

		const result = await runner.emitBeforeAgentStart("prompt", undefined, BASE_PROMPT);

		expect(result?.systemPrompt).toBeUndefined();
	});

	/**
	 * No handler and no result means the session keeps its own prompt. The runner
	 * signals that by returning undefined rather than echoing the input, and
	 * `agent-session` relies on the difference to decide whether to call
	 * `setSystemPrompt`.
	 */
	it("returns no result when nothing changed the prompt", async () => {
		const runner = await runnerWith({
			"silent.ts": `
				export default function (pi) {
					pi.on("before_agent_start", async () => undefined);
				}
			`,
		});

		expect(await runner.emitBeforeAgentStart("prompt", undefined, BASE_PROMPT)).toBeUndefined();
	});

	/**
	 * An empty array is a real value, not "no change": an extension that strips the
	 * prompt on purpose must not be treated as silent.
	 */
	it("treats an empty array as a real replacement", async () => {
		const runner = await runnerWith({
			"empty.ts": `
				export default function (pi) {
					pi.on("before_agent_start", async () => ({ systemPrompt: [] }));
				}
			`,
		});

		const result = await runner.emitBeforeAgentStart("prompt", undefined, BASE_PROMPT);

		expect(result?.systemPrompt).toEqual([]);
	});

	/** The prompt the user typed reaches the handler alongside the system prompt. */
	it("passes the user prompt through to the handler", async () => {
		const runner = await runnerWith({
			"echo.ts": `
				export default function (pi) {
					pi.on("before_agent_start", async event => ({
						systemPrompt: [...event.systemPrompt, "saw:" + event.prompt],
					}));
				}
			`,
		});

		const result = await runner.emitBeforeAgentStart("do the thing", undefined, BASE_PROMPT);

		expect(result?.systemPrompt).toEqual(["base-one", "base-two", "saw:do the thing"]);
	});
});
