/**
 * The mnemopi suite's config root goes to a temp directory, and the home is how we know.
 *
 * This package once isolated itself by inventing a config-dir NAME: a fresh
 * `.veyyon-mnemopi-profile-iso-<snowflake>` written into `VEYYON_CONFIG_DIR`. The variable
 * is a NAME joined onto `os.homedir()`, never a path that replaces it, so every run minted
 * a brand new config root INSIDE the operator's home. 131 of those directories were counted
 * in one real home. Nothing failed while it happened, and nothing could: from inside the
 * suite the resolver answers an absolute path that exists and is writable either way.
 *
 * So the contract pinned here is not a path shape. It is that THE HOME DIRECTORY IS
 * UNCHANGED across a mnemopi suite that resolves the config root and writes through it,
 * which is the one question the two arrangements answer differently.
 *
 * This file supplies the write and `useMnemopiTestEnv()` supplies the verdict: its
 * `afterAll` compares the home's `.veyyon*` entries with the ones it listed before entering
 * isolation, for every mnemopi file. Restore the bare name in `setup.ts` and both halves go
 * red together, the first case because the cache lands under the home and the hook because
 * a directory it never saw before is sitting there afterwards.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, rmdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getFastembedCacheDir } from "@veyyon/utils";
import { useMnemopiTestEnv } from "./setup";

useMnemopiTestEnv();

function veyyonSiblingsInHome(): string[] {
	return readdirSync(os.homedir())
		.filter(entry => entry.startsWith(".veyyon"))
		.sort();
}

/**
 * The preload gives every test process a sandbox home under the temp directory. A CI lane
 * doing a real install disables that with `VEYYON_ALLOW_REAL_HOME=1`, and the control case
 * below creates a directory in whatever home it is given, so it runs only when the home is
 * demonstrably not a person's.
 */
const homeIsSandboxed = (): boolean => !path.relative(os.tmpdir(), os.homedir()).startsWith("..");

describe("the mnemopi config root", () => {
	it("puts the fastembed cache in the temp root rather than under the home directory", () => {
		// The path this package actually creates: the fastembed model cache is derived from the
		// config root, and it is what five suites were making under the operator's real home
		// before the shared setup existed.
		const cache = getFastembedCacheDir();
		mkdirSync(cache, { recursive: true });

		expect(path.isAbsolute(cache)).toBe(true);
		expect(path.relative(os.tmpdir(), cache).startsWith("..")).toBe(false);
		expect(path.relative(os.homedir(), cache).startsWith("..")).toBe(true);
	});

	it.skipIf(!homeIsSandboxed())(
		"would notice a config root that appears in the home, which is all the bare name ever did",
		() => {
			const before = veyyonSiblingsInHome();
			// The directory `VEYYON_CONFIG_DIR = ".veyyon-mnemopi-profile-iso-<id>"` produced,
			// created directly rather than through the variable so the defect is demonstrated and
			// not reintroduced. In this process the home is the preload's temp sandbox.
			const strayRoot = path.join(os.homedir(), ".veyyon-mnemopi-config-root-control");
			mkdirSync(strayRoot);
			try {
				expect(veyyonSiblingsInHome()).toEqual([...before, ".veyyon-mnemopi-config-root-control"].sort());
			} finally {
				rmdirSync(strayRoot);
			}

			expect(veyyonSiblingsInHome()).toEqual(before);
		},
	);
});
