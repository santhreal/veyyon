import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

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
 * Every `.veyyon*` entry sitting DIRECTLY in the home, sorted.
 *
 * That is the exact shape the mistake this package's isolation replaced leaves behind:
 * `VEYYON_CONFIG_DIR` is a directory NAME joined onto `os.homedir()`, so a fresh
 * `.veyyon-mnemopi-profile-iso-<id>` is a config root in the home rather than out of it.
 * Reading the directory is the only way to see it, because every path the suite resolves
 * looks correct from inside the suite.
 */
function veyyonSiblingsInHome(): string[] {
	return readdirSync(homedir())
		.filter(entry => entry.startsWith(".veyyon"))
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
	let siblingsBefore: string[] = [];

	beforeAll(() => {
		siblingsBefore = veyyonSiblingsInHome();
		isolated = enterIsolatedConfigRoot("mnemopi-suite", { defaultProfile: true });
	});

	afterAll(() => {
		isolated?.restore();
		isolated = undefined;
		expect(veyyonSiblingsInHome()).toEqual(siblingsBefore);
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
