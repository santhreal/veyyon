/**
 * The tripwire that makes it IMPOSSIBLE for a mnemopi suite to load the real
 * fastembed embedding model, rather than merely asking it not to.
 *
 * ## Why this exists
 *
 * mnemopi's whole package sat in `localOnlyWorkspacePackages` in
 * `scripts/ci-test-ts.ts` and ran in NO CI job at all. The recorded reason was
 * that "its embedding suites depend on a ~270MB fastembed model absent from CI
 * runners". Measurement contradicted it: all 104 suites pass with the model
 * cache empty and the network unreachable, because every one of them injects a
 * fake provider or a fake initializer. The rationale described a hazard, not the
 * suite, and a whole package's coverage was traded for it.
 *
 * So mnemopi runs in CI's workspace bucket now. The hazard was still real, and
 * this is what replaces the blanket exclusion: `FlagEmbedding.init` is the call
 * that downloads the weights, and here it throws instead. A suite that starts
 * needing the real model fails on its first embed with a message naming itself,
 * on the developer's machine and in CI alike, instead of quietly pulling 270MB
 * into a runner and turning the bucket slow and flaky.
 *
 * A preload rather than a helper for the same reason the real-data tripwire is
 * one: nothing opts in and nothing can forget to call it. Only 15 of the 104
 * suites call `useMnemopiTestEnv()`, so a helper-shaped guard would cover the
 * minority and read as if it covered all of them.
 *
 * ## What is intercepted
 *
 * `FlagEmbedding.init`, the fastembed entry point that fetches and opens the
 * ONNX weights. Not the `import("fastembed")` itself: a module whose import
 * THROWS is a recoverable load error to `core/fastembed-runtime`, which answers
 * it by `bun install`ing a private fastembed copy, the very download this
 * prevents. The module resolves normally and only the download refuses.
 *
 * The substitution is a `Bun.plugin` virtual module, registered at resolution
 * time. NOT `mock.module`, which AGENTS.md forbids outright: it mutates the
 * global module registry and leaks into every file that links after it
 * (oven-sh/bun#12823). A resolver hook has no such registry to poison, and a
 * preload is where module substitution belongs anyway.
 *
 * Name resolution (`FASTEMBED_ID_BY_HF_REPO`), the install-plan pins, and the
 * sidecar-repair fetches are untouched. They are the suites that assert about
 * the model without loading it, and they must keep working.
 *
 * ## Running a suite that genuinely needs the model
 *
 * Set `MNEMOPI_ALLOW_FASTEMBED_MODEL=1`. That is a local, deliberate act: such a
 * suite must not run in the CI bucket, so it belongs in an exclusion that names
 * it and says why.
 */

import type { BunPlugin } from "bun";

/** Env opt-out, for a local run that means to download and use the real weights. */
export const ALLOW_ENV_VAR = "MNEMOPI_ALLOW_FASTEMBED_MODEL";

/** The refusal a suite sees when it reaches the real model. Asserted on by the tripwire's own test. */
export const FASTEMBED_MODEL_TRIPWIRE_MESSAGE =
	"FASTEMBED MODEL TRIPWIRE: this suite reached FlagEmbedding.init, which downloads the ~270MB fastembed " +
	"weights. mnemopi's suites run in CI's workspace bucket, which has no model cache and no budget for that " +
	"download, so every suite must inject its own embeddings (setEmbeddingProviderForTests or " +
	"setLocalModelInitializerForTests). If this suite genuinely needs the real model, it cannot run in that " +
	`bucket: exclude it by name with the reason, and run it locally with ${ALLOW_ENV_VAR}=1.`;

/**
 * Marker the tripwire's own test reads before it calls `init`.
 *
 * Without it that test would have to call `init` to find out whether the preload
 * is wired, and if it is NOT wired the call is the 270MB download itself. The
 * marker lets the test fail on a missing preload instead of demonstrating it.
 */
export const TRIPWIRE_MARKER = "__mnemopiFastembedModelTripwire";

if (process.env[ALLOW_ENV_VAR] !== "1") {
	const tripwire: BunPlugin = {
		name: "mnemopi:fastembed-model-tripwire",
		setup(build) {
			build.module("fastembed", () => ({
				loader: "object",
				exports: {
					[TRIPWIRE_MARKER]: true,
					FlagEmbedding: {
						init(): never {
							throw new Error(FASTEMBED_MODEL_TRIPWIRE_MESSAGE);
						},
					},
				},
			}));
		},
	};
	Bun.plugin(tripwire);
}
