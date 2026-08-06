/**
 * The deliberately hostile suite. NOT collected by `bun test`: `.fixture.ts`, not `.test.ts`.
 *
 * It is the acceptance proof for the whole sandbox gate, and it is the one file in the
 * repository whose job is to ATTACK the operator's home. It writes `~/.veyyon/leaked`
 * through every door the tripwire hooks, using the real `os.homedir()`, with no isolation
 * helper and no temp directory anywhere in it. Run it two ways and the gate is proved:
 *
 *   bash scripts/test-sandbox/run.sh bun packages/utils/test/hostile-leak-probe.fixture.ts
 *       -> runs, and `~/.veyyon/leaked*` does not exist on the HOST afterwards.
 *
 *   bun packages/utils/test/hostile-leak-probe.fixture.ts
 *       -> REFUSED before a single line below executes, by the import on the next line.
 *
 * ## Why that import is here and not left to the preload
 *
 * Because leaving it to the preload does not work, and this file is how that was found.
 * Bun's `[test] preload` in `bunfig.toml` applies to `bun test`, NOT to `bun <file>` or
 * `bun run`. The first version of this fixture had no import, was run as a plain script to
 * check the refusal, and instead sailed past both the gate and the tripwire and created
 * nine real files in the operator's real `~/.veyyon`. They were removed and the home was
 * verified back at its previous 137 entries, but the lesson is the point: for a standalone
 * script there is no preload, so a script that can reach config has to arm the gate itself.
 * The kernel boundary is what covers the scripts that forget; this import is what covers
 * the one script whose entire purpose is to try.
 *
 * It is a fixture rather than a test on purpose, and the reason is the one that makes
 * `deliberate-leak-fixtures-are-not-collectible.test.ts` exist: a file that tries to write
 * into the real home must not be something an ordinary `bun test` can pick up by walking a
 * directory. It is invoked by name, never by collection.
 */

// FIRST. Exits the process when isolation is not proven, before anything below is reached.
import "./helpers/sandbox-gate";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const target = path.join(os.homedir(), ".veyyon", "leaked");
const doors: ReadonlyArray<readonly [string, () => unknown]> = [
	["fs.writeFileSync", () => fs.writeFileSync(`${target}-fs`, "x")],
	["fs.mkdirSync", () => fs.mkdirSync(`${target}-mkdir`, { recursive: true })],
	["fs.promises.writeFile", () => fs.promises.writeFile(`${target}-fsp`, "x")],
	["Bun.write", () => Bun.write(`${target}-bunwrite`, "x")],
	["Bun.file().write", () => Bun.file(`${target}-bunfile`).write("x")],
	[
		"Bun.file().writer",
		() => {
			const writer = Bun.file(`${target}-bunwriter`).writer();
			writer.write("x");
			return writer.end();
		},
	],
	["Bun.spawnSync", () => Bun.spawnSync(["sh", "-c", `printf x > ${target}-bunspawn`])],
	["child_process.execFileSync", () => execFileSync("sh", ["-c", `printf x > ${target}-cpspawn`])],
	["Bun.$", () => Bun.$`printf x > ${`${target}-bunshell`}`.quiet()],
];

let refused = 0;
let allowed = 0;
for (const [name, attempt] of doors) {
	try {
		await attempt();
		allowed++;
		process.stdout.write(`ALLOWED   ${name}\n`);
	} catch (error) {
		refused++;
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`refused   ${name}: ${message.split("\n")[0]?.slice(0, 90)}\n`);
	}
}

process.stdout.write(`\nhome seen by this process: ${os.homedir()}\n`);
process.stdout.write(`refused ${refused}, allowed ${allowed}\n`);
