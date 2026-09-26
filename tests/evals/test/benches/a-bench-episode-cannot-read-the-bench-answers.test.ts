/**
 * WHY: browser run code has Node's full file access, and bench episodes read a task's expected answer
 * out of the bench sources and out of an earlier run's results. Where the kernel has Landlock, this
 * suite runs the real `runCliEpisode` on a tree whose `cli.ts` is a probe. It proves the episode
 * cannot open the tests of its own tree or of this runner, or read or write a sibling episode's
 * directory, while its own files, the config overlay, its cwd, its home and `/dev` still work and a
 * package still resolves from the tree's `node_modules`, so a sandbox that refused everything, or
 * the directories module resolution walks, would fail too.
 *
 * Not caught: that the invoking user's home is hidden (the suite never writes there) and that `/tmp`
 * and `/proc` stay writable for Chrome; a real bench episode is the check for both. Without Landlock
 * (every host but Linux, a kernel without it, or no python3) the case skips.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { episodeSandbox, runCliEpisode, writeBrowserOverlay } from "../../benches/cli-episode";

/** Imports a package the tree installs, reads and writes what its last argument names, and says what happened. */
const PROBE = `import * as fs from "node:fs";
import { value } from "probe-dep";
const plan = JSON.parse(process.argv.at(-1));
const reads = {};
for (const file of plan.read) {
	try { reads[file] = fs.readFileSync(file, "utf8"); } catch (error) { reads[file] = error.code; }
}
const writes = {};
for (const file of plan.write) {
	try { fs.writeFileSync(file, ""); writes[file] = "ok"; } catch (error) { writes[file] = error.code; }
}
console.log(JSON.stringify({ home: process.env.HOME, dep: value, reads, writes }));
`;

describe("a bench episode", () => {
	it.skipIf(!episodeSandbox().usable)("opens its own files and none of the bench's answers", async () => {
		await using dir = await TempDir.create("@evals-test-episode-sandbox-");
		// The tree sits inside the hidden work directory, so only its own grant makes it readable, as
		// only its own grant does for a tree inside the user's home on a bench host.
		const work = dir.join("work");
		const config = await writeBrowserOverlay(work);
		const cli = path.join(work, "tree/packages/coding-agent/src/cli.ts");
		const answers = path.join(work, "tree/tests/evals/benches/answers.ts");
		await fs.mkdir(path.dirname(cli), { recursive: true });
		await fs.mkdir(path.dirname(answers), { recursive: true });
		await fs.writeFile(cli, PROBE);
		await fs.writeFile(answers, "the expected answer");
		const dep = path.join(work, "tree/node_modules/probe-dep");
		await fs.mkdir(dep, { recursive: true });
		await fs.writeFile(
			path.join(dep, "package.json"),
			'{ "name": "probe-dep", "type": "module", "exports": "./index.js" }',
		);
		await fs.writeFile(path.join(dep, "index.js"), 'export const value = "resolved";');
		const sibling = path.join(work, "other-0", "events.jsonl");
		await fs.mkdir(path.dirname(sibling), { recursive: true });
		await fs.writeFile(sibling, "an earlier episode's answer");
		const cwd = path.join(work, "probe-0");
		const home = path.join(work, ".homes", "probe-0");
		const taskFile = path.join(cwd, "task.txt");
		const runnerTasks = path.join(import.meta.dirname, "../../benches/web-tasks.ts");
		const plan = {
			read: [taskFile, config, answers, runnerTasks, sibling],
			write: [path.join(cwd, "out.txt"), path.join(home, "out.txt"), "/dev/null", path.join(work, "other-0", "x")],
		};

		const run = await runCliEpisode({
			cli,
			model: "none",
			prompt: JSON.stringify(plan),
			work,
			episode: "probe-0",
			config,
			timeoutMs: 30_000,
			agentDir: undefined,
			files: { "task.txt": "the task's own file" },
		});

		expect(JSON.parse(run.stdout)).toEqual({
			home,
			dep: "resolved",
			reads: {
				[taskFile]: "the task's own file",
				[config]: "browser:\n  enabled: true\n",
				[answers]: "EACCES",
				[runnerTasks]: "EACCES",
				[sibling]: "EACCES",
			},
			writes: {
				[path.join(cwd, "out.txt")]: "ok",
				[path.join(home, "out.txt")]: "ok",
				"/dev/null": "ok",
				[path.join(work, "other-0", "x")]: "EACCES",
			},
		});
	});
});
