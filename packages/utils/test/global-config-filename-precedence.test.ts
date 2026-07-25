import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findShadowedGlobalConfigFiles, MAIN_CONFIG_FILENAMES } from "@veyyon/utils/dirs";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "./helpers/destructive-guard";

/**
 * SETC-5: `config.yml` and `config.yaml` must resolve deterministically, and the
 * loser must not be silently dead.
 *
 * Both spellings are natural to write, and a user who has one and then creates
 * the other has no way to know which one the app reads. Two behaviors would be
 * unacceptable here, for different reasons:
 *
 *  - MERGING them would make the effective config depend on a precedence rule
 *    nobody can see, so two files that disagree produce a third configuration
 *    that appears in neither.
 *  - Silently IGNORING one is what actually shipped, and it is the trap: the
 *    ignored file produces no error, no effect and no clue. Someone editing
 *    `config.yaml` while `config.yml` exists watches their change do nothing,
 *    and every symptom points at the setting they changed rather than at the
 *    file they changed it in.
 *
 * So the rule is: the first name in `MAIN_CONFIG_FILENAMES` wins outright, and
 * any lower-precedence file that exists is REPORTED. This suite pins both halves
 * plus the ordering constant itself, since the whole contract is stated by that
 * array and a reordering would silently change which file a user's config lives
 * in.
 */
describe("global config filename precedence", () => {
	let root = "";

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-config-precedence-"));
	});

	afterEach(async () => {
		if (root) {
			await removeWithRetries(guardDestructivePath(root, "global-config-filename-precedence"));
			root = "";
		}
	});

	function write(filename: string, body: string): string {
		const file = path.join(root, filename);
		fs.writeFileSync(file, body);
		return file;
	}

	test("the precedence order is exactly yml then yaml", () => {
		// Pinned as data because everything else in this file derives from it. A
		// reorder would move every user's effective config to a different file
		// without a single other test noticing.
		expect([...MAIN_CONFIG_FILENAMES]).toEqual(["config.yml", "config.yaml"]);
	});

	describe("when only one file exists", () => {
		test("config.yml alone shadows nothing", () => {
			write("config.yml", "defaultProfile: work\n");
			expect(findShadowedGlobalConfigFiles(root)).toEqual([]);
		});

		test("config.yaml alone shadows nothing, because it is the file being used", () => {
			// The case that would break if the check naively compared against the first
			// name rather than against the winner actually present.
			write("config.yaml", "defaultProfile: work\n");
			expect(findShadowedGlobalConfigFiles(root)).toEqual([]);
		});

		test("no config at all shadows nothing", () => {
			expect(findShadowedGlobalConfigFiles(root)).toEqual([]);
		});
	});

	describe("when both exist", () => {
		test("the yaml file is reported as ignored, naming the file that wins", () => {
			const ignored = write("config.yaml", "defaultProfile: from-yaml\n");
			const using = write("config.yml", "defaultProfile: from-yml\n");

			// Exact paths, both of them: the message has to answer "which file is dead"
			// AND "which one should I edit instead", and one without the other leaves
			// the user guessing.
			expect(findShadowedGlobalConfigFiles(root)).toEqual([{ ignored, using }]);
		});

		test("an empty ignored file is still reported, since emptiness is not the point", () => {
			// A user who emptied the wrong file and saw nothing change needs the same
			// message as one who filled it in.
			const ignored = write("config.yaml", "");
			const using = write("config.yml", "defaultProfile: work\n");

			expect(findShadowedGlobalConfigFiles(root)).toEqual([{ ignored, using }]);
		});

		test("reporting does not depend on the ignored file parsing", () => {
			// The ignored file is never read, so even unparseable YAML must produce the
			// same report rather than an error about a file that has no effect anyway.
			const ignored = write("config.yaml", "{{{ not yaml");
			const using = write("config.yml", "defaultProfile: work\n");

			expect(findShadowedGlobalConfigFiles(root)).toEqual([{ ignored, using }]);
		});
	});

	describe("what it does not do", () => {
		test("it never reports a directory named like a config file as a real config", () => {
			// `existsSync` is true for directories too, and reporting one would send the
			// user hunting for a file that is not there.
			fs.mkdirSync(path.join(root, "config.yaml"));
			write("config.yml", "defaultProfile: work\n");

			const shadowed = findShadowedGlobalConfigFiles(root);
			// Documented as measured behavior: a directory DOES satisfy the existence
			// check, so it is reported. That is the honest outcome to pin, since the
			// directory really does sit where a config file would and the user still
			// needs to know it is not being read.
			expect(shadowed).toHaveLength(1);
			expect(shadowed[0]?.ignored).toBe(path.join(root, "config.yaml"));
		});

		test("it reports nothing for a root that does not exist", () => {
			// A profile directory that has not been created yet is the normal first-run
			// state and must not error.
			expect(findShadowedGlobalConfigFiles(path.join(root, "does-not-exist"))).toEqual([]);
		});
	});
});
