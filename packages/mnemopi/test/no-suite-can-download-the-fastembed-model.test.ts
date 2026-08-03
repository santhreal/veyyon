import { describe, expect, test } from "bun:test";
import { loadFastembed } from "../src/core/fastembed-runtime";
import { FASTEMBED_MODEL_TRIPWIRE_MESSAGE, TRIPWIRE_MARKER } from "./helpers/fastembed-model-tripwire";

/**
 * The loaded fastembed module's `FlagEmbedding.init`, narrowed rather than asserted.
 *
 * Every step is a real check because the preload being absent is precisely the
 * case this file has to survive: an asserted shape would sail past a missing
 * marker and call the REAL `init`, which is the 270MB download. Reaching the end
 * of this function is itself the proof that the tripwire is installed.
 */
function tripwiredInit(module: unknown): (options: unknown) => unknown {
	if (module === null || typeof module !== "object" || !(TRIPWIRE_MARKER in module)) {
		throw new Error(
			`the fastembed module carries no ${TRIPWIRE_MARKER}, so the tripwire preload is not installed. ` +
				`Check the [test] preload list in packages/mnemopi/bunfig.toml. Not calling init: without the ` +
				`preload that call is the download itself.`,
		);
	}
	if (!("FlagEmbedding" in module)) throw new Error("the tripwire module exports no FlagEmbedding");
	const flagEmbedding = module.FlagEmbedding;
	if (flagEmbedding === null || typeof flagEmbedding !== "object" || !("init" in flagEmbedding)) {
		throw new Error("the tripwire's FlagEmbedding exports no init");
	}
	const init = flagEmbedding.init;
	if (typeof init !== "function") throw new Error("the tripwire's FlagEmbedding.init is not callable");
	// Checked above: `init` is a function on the tripwire's own object literal, and
	// the only shape fastembed's real `init` is ever called with is an options bag.
	return init as (options: unknown) => unknown;
}

/**
 * The one assertion that lets this package run in CI.
 *
 * mnemopi ran in NO CI job for as long as `scripts/ci-test-ts.ts` listed it in
 * `localOnlyWorkspacePackages`, on the recorded grounds that "its embedding
 * suites depend on a ~270MB fastembed model absent from CI runners". Every suite
 * here in fact passes with the model cache empty and the network unreachable:
 * most never produce a vector, the ones that do inject a fake provider or a fake
 * initializer, and `getLocalModel` returns null outright under the test runner
 * (`inTestRuntime`, covered by `optional-embeddings.test.ts`). The rationale
 * named a hazard and then excluded a package, which cost every other suite in it
 * their CI run.
 *
 * The hazard is still reachable, and by a route this package already uses:
 * `optional-embeddings.test.ts` clears NODE_ENV on purpose to exercise the local
 * path. It stubs the initializer, so it downloads nothing. A suite that clears
 * NODE_ENV and forgets the stub would call the real `FlagEmbedding.init` and
 * pull the weights into a CI runner. The preload closes that door, and this is
 * what proves the door is closed rather than assumed to be.
 */
describe("the fastembed download door", () => {
	test("refuses FlagEmbedding.init and names what the suite must do instead", async () => {
		const init = tripwiredInit(await loadFastembed());

		expect(() => init({ model: "fast-bge-small-en-v1.5" })).toThrow(FASTEMBED_MODEL_TRIPWIRE_MESSAGE);
	});

	// The refusal is only useful if it tells the reader which way out applies to
	// them. A bare "not allowed" sends them to git history, which is the failure
	// mode this whole change is about.
	test("says how to run a suite that genuinely needs the weights", () => {
		expect(FASTEMBED_MODEL_TRIPWIRE_MESSAGE).toContain("setLocalModelInitializerForTests");
		expect(FASTEMBED_MODEL_TRIPWIRE_MESSAGE).toContain("MNEMOPI_ALLOW_FASTEMBED_MODEL=1");
	});
});
