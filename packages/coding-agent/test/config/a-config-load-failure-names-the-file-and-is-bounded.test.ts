/**
 * A config file that will not load must say WHICH FILE, and must not paste the
 * file back at you.
 *
 * TWO DEFECTS, BOTH MEASURED AGAINST `ModelsConfigFile` BEFORE THE FIX.
 *
 * 1. UNBOUNDED. `ConfigError` echoed every ArkType problem verbatim, and ArkType
 *    writes the REJECTED VALUE into its problem text (`transport: must be
 *    "pi-native" (was "zzz…")`). So the file set the length of the message about
 *    the file. One 50,000-character value produced a 50,100-character error, and
 *    400 short bad providers produced 25,538 characters across 401 lines, every
 *    line individually small. That is the same shape as the tool-argument
 *    validation failure that once reproduced 50,437 characters: caps that do not
 *    compose, or in this case no caps at all. It is not a display-only cost —
 *    `veyyon models` prints this message line by line and startup pushes it into
 *    the notification list.
 *
 * 2. NO LOCATION AND NO NEXT STEP. The message named the config ID (`models`),
 *    and an ID is not a location: the same ID resolves to a different file per
 *    profile and the loader falls back across `.yml`, `.yaml` and `.json`. The
 *    path was already in hand and went to `logger.warn` on the line below the
 *    throw, so the file log knew and the operator did not. A YAML syntax error
 *    read `Failed to load config file models, Unexpected error: YAML Parse
 *    error: Unexpected token` — 87 characters naming neither the file nor
 *    anything to do.
 *
 * WHY THE FIXTURE PASSES AN EXPLICIT PATH. `ConfigFile`'s third constructor
 * argument is the config path, so this suite never resolves a home directory at
 * all: the file lives in a per-test temp directory and the assertions can name
 * it exactly.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigFile, deferSchema } from "@veyyon/coding-agent/config/config-file";
import { type } from "arktype";

/** One closed-set key, so a bad value produces a problem naming the value. */
const SCHEMA = type({ "providers?": { "[string]": { "transport?": '"pi-native"' } } });

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-config-error-"));
	file = path.join(dir, "probe.yml");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function loadError(content: string): Error {
	fs.writeFileSync(file, content);
	const config = new ConfigFile(
		"probe",
		deferSchema(() => SCHEMA),
		file,
	);
	const error = config.tryLoad().error;
	if (!error) throw new Error("expected the config load to fail");
	return error as Error;
}

describe("a config load failure", () => {
	/**
	 * The single-oversized-value case. Asserted as a hard ceiling rather than an
	 * exact length because the ceiling is the contract: the number that matters is
	 * that it no longer scales with the file.
	 */
	it("does not grow with the size of one rejected value", () => {
		const message = loadError(JSON.stringify({ providers: { p: { transport: "z".repeat(50_000) } } })).message;
		const [firstLine] = message.split("\n");
		const titlePrefix = `Failed to load config file probe (${file}), Schema error: `;
		expect(message.length).toBeLessThanOrEqual(4500);
		expect(firstLine).toStartWith(`${titlePrefix}providers.p.transport: must be "pi-native" (was "z`);
		// The issue text is cut to exactly the per-issue cap, ellipsis included, so
		// the 50,000-character value contributes 200 characters and not 50,000.
		expect(firstLine.length).toBe(titlePrefix.length + 200);
		expect(firstLine).toEndWith("…");
	});

	/**
	 * The many-small-problems case, which a per-issue cap alone does not catch.
	 * The count is asserted because dropping the tail silently would be a
	 * different defect: the reader must know there is more wrong with the file.
	 */
	it("lists a bounded number of problems and says how many it dropped", () => {
		const providers: Record<string, { transport: string }> = {};
		for (let index = 0; index < 400; index++) providers[`p${index}`] = { transport: "bogus" };

		const message = loadError(JSON.stringify({ providers })).message;

		expect(message.split("\n").filter(line => line.startsWith("  - ")).length).toBe(21);
		expect(message).toContain("… 380 more of 400 problem(s) not shown");
		expect(message.length).toBeLessThanOrEqual(4500);
	});

	/**
	 * The case that makes the WHOLE-MESSAGE ceiling load-bearing rather than
	 * decorative. Each of the two caps above holds and the total still overflows:
	 * twenty issues at the 200-character cap is 4,000 characters on its own, and
	 * the path now appears TWICE (the title and the `Fix:` line), so a long config
	 * root adds twice its own length on top. A deep profile path is ordinary, not
	 * hostile. Without the final `truncate` this composes to over 4,700
	 * characters, which is precisely the "per-field caps that never compose into a
	 * total" failure.
	 */
	it("bounds the whole message when the capped parts still add up past the ceiling", () => {
		const deep = path.join(dir, "a".repeat(60), "b".repeat(60), "c".repeat(60), "d".repeat(60));
		fs.mkdirSync(deep, { recursive: true });
		const deepFile = path.join(deep, "probe.yml");
		const providers: Record<string, { transport: string }> = {};
		for (let index = 0; index < 20; index++) providers[`p${index}`] = { transport: "z".repeat(500) };
		fs.writeFileSync(deepFile, JSON.stringify({ providers }));

		const config = new ConfigFile(
			"probe",
			deferSchema(() => SCHEMA),
			deepFile,
		);
		const message = (config.tryLoad().error as Error | undefined)?.message ?? "";

		// The parts, before the ceiling: 20 lines at the per-issue cap plus a path
		// long enough that naming it twice is itself most of a kilobyte.
		expect(deepFile.length).toBeGreaterThan(240);
		expect(message.length).toBe(4500);
		expect(message).toEndWith("…");
	});

	it("names the file and the fix for a syntax error, which names no key at all", () => {
		expect(loadError("providers: { unterminated: [").message).toBe(
			`Failed to load config file probe (${file}), Unexpected error: YAML Parse error: Unexpected token\n` +
				`Fix: edit ${file}, or delete it to fall back to the defaults.`,
		);
	});

	/**
	 * Every failure stage, because the location and the remedy were missing from
	 * all of them and a fix applied to the branch someone happened to open is the
	 * defect class this session keeps finding. `Read` is exercised by making the
	 * config a DIRECTORY, which is a real operator mistake (`mkdir` where a file
	 * belongs) and the one non-ENOENT read failure a test can create portably.
	 */
	it("names the file and a remedy for a read failure as well as a parse failure", () => {
		fs.rmSync(file, { force: true });
		fs.mkdirSync(file);
		const config = new ConfigFile(
			"probe",
			deferSchema(() => SCHEMA),
			file,
		);

		const message = (config.tryLoad().error as Error | undefined)?.message ?? "";

		expect(message).toStartWith(`Failed to load config file probe (${file}), Read error:`);
		expect(message).toEndWith(`Fix: edit ${file}, or delete it to fall back to the defaults.`);
	});

	/** A file that loads must produce no error, so the bounds above cannot be passing by refusing everything. */
	it("loads a valid file", () => {
		fs.writeFileSync(file, JSON.stringify({ providers: { p: { transport: "pi-native" } } }));
		const config = new ConfigFile(
			"probe",
			deferSchema(() => SCHEMA),
			file,
		);
		expect(config.tryLoad().status).toBe("ok");
	});
});
