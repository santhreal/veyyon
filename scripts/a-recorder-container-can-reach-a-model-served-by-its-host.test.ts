// WHY THIS EXISTS
//
// `scripts/demos/record-hd-demo.sh` refuses a non-loopback `PROOF_LLM_BASE_URL`
// unless `ALLOW_REMOTE_MODEL=1`: a take whose tokens cross a network records the
// network's pauses and blames them on the product, so the model must be served by
// the machine doing the recording. The recorders then run the session inside a
// container on a docker bridge, where that same loopback address is the container
// itself — so the address the host check demands is the one address the session
// cannot use. The hero take was launched against `http://127.0.0.1:11434/v1` and
// would have spent its whole first-token timeout dialling a closed port in the
// sandbox, publishing a spinner as the demo.
//
// THE CLASS THIS CLOSES. Not "the x11 recorder in that one configuration": any
// recorder handing the container an endpoint that resolves inside the container.
// The recorder set is read off `proof/docker/` at run time and pinned by exact
// equality, so a new recorder fails this suite until it is wired, and each one is
// exercised through its real docker invocation with a stub `docker` recording the
// argv — the translation and the `--add-host` route are asserted together, because
// either alone still leaves the session unable to dial the model.
//
// WHAT IT DOES NOT CATCH. Whether the host's server is actually bound beyond
// loopback: a model server listening on `127.0.0.1` only is unreachable from the
// bridge whatever name the container dials, and nothing in these argv can see
// that. It also does not prove docker publishes `host-gateway` on the running
// daemon (a very old daemon does not), only that the recorder asks for it.
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
const HELPER = path.join(DOCKER_DIR, "host-endpoint.sh");

/** The gateway alias the helper owns. Asserted, not assumed, below. */
const ALIAS = "host.docker.internal";

/**
 * The recorders that hand a model endpoint to a container, discovered at run time.
 *
 * Not every `record-*.sh` talks to a model: one records a checked-out commit and one
 * replays a session file, and a container with no endpoint has nothing to misroute.
 * The scan finds the ones that forward it, so a recorder that starts forwarding is
 * swept into the argv assertions below the day it lands rather than when somebody
 * remembers this file. Discovery is by text; every assertion is by behaviour.
 */
const ENDPOINT_FORWARDERS = readdirSync(DOCKER_DIR)
	.filter(name => /^record-.*\.sh$/.test(name))
	.filter(name => readFileSync(path.join(DOCKER_DIR, name), "utf8").includes("PROOF_LLM_BASE_URL="))
	.sort();

/** `container_endpoint <url>`, through the shell that ships it. */
async function translate(url: string): Promise<string> {
	const { stdout } = await run("bash", ["-c", `source "${HELPER}"; container_endpoint "$1"`, "_", url]);
	return stdout;
}

interface StubRun {
	argv: string[];
	joined: string;
}

/** Run a recorder with a stub `docker` and return the argv it was handed. */
async function recorderArgv(recorder: string, endpoint: string | undefined): Promise<StubRun> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recorder-argv-"));
	try {
		const argvFile = path.join(dir, "argv.txt");
		const stub = path.join(dir, "docker");
		await fs.writeFile(stub, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >>"$ARGV_FILE"; done\n');
		await fs.chmod(stub, 0o755);
		// wlroots refuses to start without a render node and the recorder checks for
		// one before it spawns anything, so the wayland arm needs a path that exists.
		const renderNode = path.join(dir, "renderD128");
		await fs.writeFile(renderNode, "");
		const env: Record<string, string> = {
			...process.env,
			ARGV_FILE: argvFile,
			PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
			OUT_DIR: path.join(dir, "out"),
			RENDER_NODE: renderNode,
		};
		if (endpoint === undefined) delete env.PROOF_LLM_BASE_URL;
		else env.PROOF_LLM_BASE_URL = endpoint;
		await run("bash", [path.join(DOCKER_DIR, recorder), "proof/scenes/demo-hd.sh"], { env });
		const argv = (await fs.readFile(argvFile, "utf8")).split("\n").filter(line => line.length > 0);
		return { argv, joined: argv.join("\n") };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("a recorder container can reach a model served by its host", () => {
	it("forwards an endpoint from exactly the two session recorders", () => {
		expect(ENDPOINT_FORWARDERS).toEqual(["record-wl.sh", "record-x11.sh"]);
	});

	it("names the gateway alias in the helper both recorders source", async () => {
		const { stdout } = await run("bash", ["-c", `source "${HELPER}"; printf '%s' "$CONTAINER_HOST_ALIAS"`]);
		expect(stdout).toBe(ALIAS);
	});

	it.each([
		["http://127.0.0.1:11434/v1", `http://${ALIAS}:11434/v1`],
		["http://localhost:11434/v1", `http://${ALIAS}:11434/v1`],
		["http://0.0.0.0:8080/v1", `http://${ALIAS}:8080/v1`],
		["http://[::1]:11434/v1", `http://${ALIAS}:11434/v1`],
		["https://127.0.0.1/v1", `https://${ALIAS}/v1`],
	])("routes %p out of the container", async (given, expected) => {
		expect(await translate(given)).toBe(expected);
	});

	it.each([
		["http://veyyon-proof-llm:8080/v1", "http://veyyon-proof-llm:8080/v1"],
		// A host whose NAME merely starts with a loopback spelling is a real host.
		["http://localhost-mirror.example:80/v1", "http://localhost-mirror.example:80/v1"],
		["http://192.168.0.135:11434/v1", "http://192.168.0.135:11434/v1"],
		["", ""],
	])("leaves %p alone", async (given, expected) => {
		expect(await translate(given)).toBe(expected);
	});

	describe.each(ENDPOINT_FORWARDERS)("%s", recorder => {
		it("hands the container the gateway endpoint and the route to it", async () => {
			const { argv, joined } = await recorderArgv(recorder, "http://127.0.0.1:11434/v1");
			expect(argv).toContain(`PROOF_LLM_BASE_URL=http://${ALIAS}:11434/v1`);
			expect(argv).toContain(`${ALIAS}:host-gateway`);
			expect(argv).toContain("--add-host");
			// The whole point: nothing the container is handed resolves to itself.
			expect(joined).not.toContain("127.0.0.1");
			expect(joined).not.toContain("localhost:");
		});

		it("passes a hostname the bridge already resolves through untouched", async () => {
			const { argv } = await recorderArgv(recorder, "http://veyyon-proof-llm:8080/v1");
			expect(argv).toContain("PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1");
		});

		it("leaves the endpoint empty when the caller sets none, so the seed's own baseUrl stands", async () => {
			const { argv } = await recorderArgv(recorder, undefined);
			expect(argv).toContain("PROOF_LLM_BASE_URL=");
		});
	});
});
