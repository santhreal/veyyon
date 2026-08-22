// WHY THIS EXISTS
//
// The product refuses to start on a bun older than the one it is built for, and
// the recorder runs the product inside an image that carries its own bun. Those
// two versions were connected by nothing: the recorder image was built by hand and
// tagged by hand (`:1`, `:2`, `:4`, `:5`), the Dockerfile's base defaulted to a
// literal `veyyon-test-guest:1.3.14`, and after the repo moved to bun 1.4.0 every
// capture path still named an image built on 1.3.14. The hero take started the
// X server, the compositor, the terminal and the recording, then died on
// `Bun runtime must be >= 1.4.0 (found v1.3.14)` from inside the container.
//
// THE CLASS THIS CLOSES. Not "that one image": any capture container named by a
// tag that does not track the declared runtime. `packageManager` in the root
// package.json is the declaration, `scripts/bun-version.sh` is its only reader,
// and every recorder resolves its tag from that. Each recorder that spawns a
// container is discovered on the filesystem and driven through a stub `docker`, so
// the image it really names is asserted rather than read out of the source, and a
// new recorder is swept the day it lands. A bump to `packageManager` moves every
// expected tag at once, which is exactly what nothing did before.
//
// WHAT IT DOES NOT CATCH. Whether an image with the right tag actually contains
// that bun: only a docker daemon can answer that, and `build-recorder.sh` asks it
// at the end of a build. This suite proves the name, and a missing image is then a
// loud docker error instead of a dead take.
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DOCKER_DIR = path.join(REPO_ROOT, "proof", "docker");

/** What the repo says it runs on. The one declaration every tag derives from. */
const DECLARED_BUN = (() => {
	const manifest: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
	const declared = (manifest as { packageManager?: string }).packageManager;
	return declared?.replace(/^bun@/, "") ?? "";
})();

const EXPECTED_IMAGE = `veyyon-proof-recorder:bun${DECLARED_BUN}`;

/**
 * Every script in `proof/docker/` that spawns a container, discovered at run time.
 *
 * A script that runs no container has no image to get wrong. Discovery is by text;
 * every assertion below is by behaviour, through the argv a stub `docker` records.
 */
const CONTAINER_SPAWNERS = readdirSync(DOCKER_DIR)
	.filter(name => name.endsWith(".sh"))
	.filter(name => readFileSync(path.join(DOCKER_DIR, name), "utf8").includes("docker run"))
	.sort();

/** Run one spawner with a stub `docker` and return the argv it produced. */
async function spawnerArgv(script: string): Promise<string[]> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-image-"));
	try {
		const argvFile = path.join(dir, "argv.txt");
		const stub = path.join(dir, "docker");
		await fs.writeFile(stub, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >>"$ARGV_FILE"; done\n');
		await fs.chmod(stub, 0o755);
		const renderNode = path.join(dir, "renderD128");
		await fs.writeFile(renderNode, "");
		const session = path.join(dir, "session.jsonl");
		await fs.writeFile(session, "");
		const env = {
			...process.env,
			ARGV_FILE: argvFile,
			PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
			OUT_DIR: path.join(dir, "out"),
			RENDER_NODE: renderNode,
		};
		// Each spawner takes a different first argument; a scene path satisfies the
		// recorders, and the one that replays a session is given a session file.
		const args = script === "record-long-session.sh" ? [session] : ["proof/scenes/demo-hd.sh"];
		// The subject is the invocation, not what a script does with the output the
		// stub never produced: a spawner that moves its own mp4 afterwards exits
		// non-zero here, and the argv it already wrote is still the evidence.
		await run("bash", [path.join(DOCKER_DIR, script), ...args], { env }).catch(() => undefined);
		const argv = (await fs.readFile(argvFile, "utf8")).split("\n").filter(line => line.length > 0);
		expect(argv.length).toBeGreaterThan(0);
		return argv;
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("a capture runs on the bun the product requires", () => {
	it("reads one declared version", () => {
		expect(DECLARED_BUN).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("derives the same version in the shell every image build reads", async () => {
		const { stdout } = await run("bash", [path.join(REPO_ROOT, "scripts", "bun-version.sh")]);
		expect(stdout.trim()).toBe(DECLARED_BUN);
	});
	// A manifest that declares no bun is a repo nobody can build an image for, and a
	// helper that shrugs would tag it `veyyon-proof-recorder:bun` and hand docker a
	// name it cannot resolve. Exercised through a faithful layout — the helper finds
	// its manifest one directory up from itself — rather than through an injected path.
	it("refuses a manifest that declares no bun", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bun-version-"));
		try {
			await fs.mkdir(path.join(dir, "scripts"));
			await fs.copyFile(
				path.join(REPO_ROOT, "scripts", "bun-version.sh"),
				path.join(dir, "scripts", "bun-version.sh"),
			);
			await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "no-declaration" }));
			const failure = await run("bash", [path.join(dir, "scripts", "bun-version.sh")]).then(
				() => undefined,
				(error: { code?: number; stderr?: string }) => error,
			);
			expect(failure?.code).toBe(2);
			expect(failure?.stderr ?? "").toContain("packageManager");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("resolves the recorder tag from that version", async () => {
		const { stdout } = await run("bash", [
			"-c",
			`source "${path.join(DOCKER_DIR, "recorder-image.sh")}"; printf '%s' "$RECORDER_IMAGE"`,
		]);
		expect(stdout).toBe(EXPECTED_IMAGE);
	});

	it("lets a caller override the tag for a scratch build", async () => {
		const { stdout } = await run(
			"bash",
			["-c", `source "${path.join(DOCKER_DIR, "recorder-image.sh")}"; printf '%s' "$RECORDER_IMAGE"`],
			{ env: { ...process.env, RECORDER_IMAGE: "scratch:1" } },
		);
		expect(stdout).toBe("scratch:1");
	});

	it("spawns containers from exactly the scripts this suite drives", () => {
		expect(CONTAINER_SPAWNERS).toEqual([
			"build-recorder.sh",
			"commit-results.sh",
			"record-commit-arm.sh",
			"record-long-session.sh",
			"record-wl.sh",
			"record-x11.sh",
			"resume-probe.sh",
			"run-recorder.sh",
		]);
	});

	// Three of those are named above and not driven here. `commit-results.sh` and
	// `record-commit-arm.sh` check out another commit before they spawn anything, so
	// driving them means fabricating a checkout. `build-recorder.sh` BUILDS the image
	// and then asks the real daemon which bun landed in it, which is the assertion a
	// stub cannot stand in for. All three resolve their tag through the same sourced
	// resolver, which is asserted directly above.
	describe.each(["record-x11.sh", "record-wl.sh", "run-recorder.sh", "record-long-session.sh", "resume-probe.sh"])(
		"%s",
		script => {
			it("names the image built for the declared bun", async () => {
				const argv = await spawnerArgv(script);
				expect(argv).toContain(EXPECTED_IMAGE);
				// No hand-numbered generation survives anywhere in the invocation.
				expect(argv.filter(arg => /^veyyon-proof-recorder:\d+$/.test(arg))).toEqual([]);
			});
		},
	);
});
