import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as Beam from "@veyyon/mnemopi/core/beam";
import * as Embeddings from "@veyyon/mnemopi/core/embeddings";
import type { CompleteOptions, LlmBackend } from "@veyyon/mnemopi/core/llm-backends";
import * as LlmBackends from "@veyyon/mnemopi/core/llm-backends";
import * as Memory from "@veyyon/mnemopi/core/memory";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";

type ResettableModule = Record<string, unknown>;

const RESET_FUNCTION_NAMES = [
	"resetForTests",
	"resetModuleStateForTests",
	"resetMemoryForTests",
	"resetBeamForTests",
	"resetEmbeddingStateForTests",
	"resetHostLlmBackendForTests",
	"resetLlmBackendStateForTests",
] as const;

const RESETTABLE_MODULES: readonly ResettableModule[] = [Memory, Beam, LlmBackends, Embeddings];

function callResetFunctions(moduleExports: ResettableModule): void {
	for (const name of RESET_FUNCTION_NAMES) {
		const reset = moduleExports[name];
		if (typeof reset === "function") {
			reset();
		}
	}
}

export function resetModuleStateForTests(): void {
	for (const moduleExports of RESETTABLE_MODULES) {
		callResetFunctions(moduleExports);
	}
}

export function disableLocalLlmForTests(): void {
	LlmBackends.setHostLlmBackend(null);
}

export function withLocalLlm(fakeResponseOrBackend: string | LlmBackend = "fake summary"): LlmBackend {
	const backend =
		typeof fakeResponseOrBackend === "string"
			? new FakeLocalLlmBackend(fakeResponseOrBackend)
			: fakeResponseOrBackend;

	LlmBackends.setHostLlmBackend(backend);
	return backend;
}

class FakeLocalLlmBackend implements LlmBackend {
	readonly name = "fake-local-llm";

	constructor(public response: string) {}

	complete(_prompt: string, _opts?: CompleteOptions): string {
		return this.response;
	}

	createChatCompletion(): { choices: [{ message: { content: string } }] } {
		return { choices: [{ message: { content: this.response } }] };
	}
}

/**
 * Every entry sitting DIRECTLY in the home that a mnemopi run could have put there, sorted.
 *
 * THREE prefixes, because this package derives three roots from the home. `.veyyon*` is the
 * shape the mistake this package's isolation replaced leaves behind: `VEYYON_CONFIG_DIR` is a
 * directory NAME joined onto `os.homedir()`, so a fresh `.veyyon-mnemopi-profile-iso-<id>` is a
 * config root in the home rather than out of it.
 *
 * `.hermes` holds the data dir, the blob store, the plugin dir, the model cache and the
 * embedding cache. `dataDir()` defaults to `~/.hermes/mnemopi/data` and every module-level
 * facade call (`remember`, `recall`, `getContext`, `getStats`) opens the database there, which is
 * a SQLite file, a `-wal` and a `-shm` in the operator's home; `storeBlob()` writes under the
 * same root and answered to no lever at all until `MNEMOPI_HOME` existed. A 372KB schema-only
 * `~/.hermes/mnemopi/data/mnemopi.db` with zero rows in every data table was found in one real
 * home, and this list is why nothing said so.
 *
 * `.mnemopi` is the cost log's, and it is the one root nothing here has ever watched:
 * `getConn()` with no argument opens `~/.mnemopi/data/cost_log.db` and creates the tree on the
 * way.
 *
 * Reading the directory is the only way to see any of them, because every path the suite
 * resolves looks correct from inside the suite.
 */
function homeRootsAMnemopiRunCouldCreate(): string[] {
	return readdirSync(homedir())
		.filter(entry => entry.startsWith(".veyyon") || entry === ".hermes" || entry === ".mnemopi")
		.sort();
}

/**
 * Per-file mnemopi test environment: module resets plus an isolated config root.
 *
 * Call this in every mnemopi suite. It is a FUNCTION rather than module-level hooks
 * because a shared setup module is imported once per test process, and hooks it
 * registers at module scope belong ONLY to the suite that imported it first — proved
 * with a two-file probe: the second file's `beforeAll`/`beforeEach` fire and the first
 * file's tests run with no hooks at all. The resets used to have exactly that shape, so
 * of the twelve files importing this module, eleven were getting none of them.
 *
 * The config root matters because the embedding path derives its fastembed model cache
 * from it (`getFastembedCacheDir()` gives `<config root>/cache/fastembed`). Five tests
 * across three files were calling `mkdirSync` on the developer's real
 * `~/.veyyon/profiles/<profile>/cache/fastembed`; the real-data tripwire refused it and
 * that is how they were found. The nine `MNEMOPI_*` and provider variables those suites
 * already snapshot cannot help: the cache root comes from `os.homedir()`, not from any
 * of them.
 *
 * Entering it per file rather than once for the process is not a detail. A root entered
 * at module scope and never restored leaks `VEYYON_CONFIG_DIR` into every OTHER
 * package's suites that share the process. That was tried, and it broke a utils test
 * asserting the config-root refusal message, which then reported a mnemopi temp path.
 *
 * The `afterAll` assertion is the part that cannot be talked out of. Isolation that is
 * only intended looks exactly like isolation that works from inside the suite: every
 * path the resolver hands back is absolute, correct and consistent whether the root is a
 * temp directory or a fresh dot-name in the operator's home. Listing the home before and
 * after is the one question with a different answer in the two cases, and every mnemopi
 * file gets it because the leak that produced 131 abandoned directories was in the shared
 * setup rather than in any one suite.
 */
export function useMnemopiTestEnv(): void {
	let isolated: IsolatedConfigRoot | undefined;
	let rootsBefore: string[] = [];
	const previous = new Map<string, string | undefined>();

	function override(name: string, value: string): void {
		previous.set(name, process.env[name]);
		process.env[name] = value;
	}

	beforeAll(() => {
		rootsBefore = homeRootsAMnemopiRunCouldCreate();
		isolated = enterIsolatedConfigRoot("mnemopi-suite", { defaultProfile: true });
		// `MNEMOPI_HOME` is the one lever over every home-derived root: `hermesRoot()` and the
		// cost log both resolve through `mnemopiHome()`, so this single variable moves the data
		// dir, the blob store, the plugin dir, the model cache and the cost log out of the real
		// home together. `VEYYON_CONFIG_DIR` reaches none of them.
		override("MNEMOPI_HOME", isolated.root);
		// `MNEMOPI_DATA_DIR` stays set as well, because it is the lever production uses and a
		// suite that reads it must see an isolated path rather than fall through to the default.
		override("MNEMOPI_DATA_DIR", join(isolated.root, "mnemopi-data"));
	});

	afterAll(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		previous.clear();
		isolated?.restore();
		isolated = undefined;
		expect(homeRootsAMnemopiRunCouldCreate()).toEqual(rootsBefore);
	});

	beforeEach(() => {
		resetModuleStateForTests();
		disableLocalLlmForTests();
	});

	afterEach(() => {
		resetModuleStateForTests();
		disableLocalLlmForTests();
	});
}
