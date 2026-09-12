/**
 * WHY: Expanded environment assignments were executed as commands when recorder options were set.
 * Exercise the real wrapper across both capture arms and paired invocation, with and without options.
 * Capture backends are replaced at the external display boundary; this does not verify image output.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const wrapper = path.join(import.meta.dirname, "record.sh");
const scratchParent = path.join(import.meta.dirname, "..", ".captures");
const settings = 'statusLine.preset: "minimal"\nstartup.quiet: true';
// biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture contains Bash parameter expansions.
const backend = 'printf "%s\\0" "$0" "$1" "$OUT_DIR" "${SCENE_WIDTH-}" "${SCENE_SETTINGS-}" "${SCENE_STILL-}" >> "$CAPTURE_INVOCATIONS"\n';

const arms = [
	{ name: "after", args: [], backends: ["record-x11.sh"] },
	{ name: "before", args: ["--before"], backends: ["record-x11-before.sh"] },
	{ name: "pair", args: ["--pair"], backends: ["record-x11-before.sh", "record-x11.sh"] },
];

describe.skipIf(process.platform === "win32")("capture wrapper environment forwarding", () => {
	for (const arm of arms) {
		it(`${arm.name} forwards every option without interpreting its value as a command`, async () => {
			await mkdir(scratchParent, { recursive: true });
			const root = await mkdtemp(path.join(scratchParent, "recorder-arguments-"));
			try {
				await mkdir(path.join(root, "proof", "docker"), { recursive: true });
				await mkdir(path.join(root, "proof", "scenes"), { recursive: true });
				const copiedWrapper = path.join(root, "proof", "record.sh");
				await copyFile(wrapper, copiedWrapper);
				await writeFile(path.join(root, "proof", "scenes", "sample.sh"), "# Synthetic scene\n");
				for (const name of ["record-x11.sh", "record-x11-before.sh"]) {
					await writeFile(path.join(root, "proof", "docker", name), backend);
				}
				const help = await run("bash", [copiedWrapper, "--help"], { timeout: 10_000 });
				expect([...new Set(help.stdout.match(/--[a-z-]+/g))].sort()).toEqual([
					"--before", "--pair", "--settings", "--still", "--width",
				]);
				for (const configured of [false, true]) {
					const record = path.join(root, `invocations-${configured}`);
					const options = configured ? ["--width", "960", "--settings", settings, "--still", "collapsed frame"] : [];
					await run("bash", [copiedWrapper, ...arm.args, ...options, "proof/scenes/sample.sh"], {
						cwd: root,
						timeout: 10_000,
						env: { ...process.env, OUT_DIR: undefined, SCENE_WIDTH: undefined, SCENE_SETTINGS: undefined, SCENE_STILL: undefined, CAPTURE_INVOCATIONS: record },
					});
					const fields = (await readFile(record, "utf8")).split("\0").slice(0, -1);
					expect(fields).toEqual(arm.backends.flatMap(name => [
						`proof/docker/${name}`,
						"proof/scenes/sample.sh",
						path.join(root, "proof", "captures", "x11", ...(name === "record-x11-before.sh" ? ["before"] : [])),
						configured ? "960" : "",
						configured ? settings : "",
						configured ? "collapsed frame" : "",
					]));
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}, 35_000);
	}
});
