/**
 * WHY: Pre-mount discovery competed with interactive initialization. Exercise the
 * CLI on a real PTY: a session_start extension records initialization, then selects
 * a model returned by a loopback discovery server. Discovery before initialization
 * or a missing post-mount refresh fails. This does not cover ACP, RPC, subsequent
 * sessions, visual settling, or remote-provider latency.
 * Real deadlines bound the separate CLI process; parent fake timers cannot advance
 * it. Its registry has no refresh-completion event, so the extension polls that
 * observable state rather than sleeping for a guessed initialization duration.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import * as path from "node:path";
import { Process } from "@veyyon/natives";
import { ptyWrapper } from "../../../scripts/bench-startup";
import { BUN_CACHE_ENV, denyHostProviderAccess } from "./helpers/hermetic-spawn-env";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("interactive discovery starts after session initialization and its model can be selected", async () => {
	const parent = path.join(repoRoot, ".captures", "refresh-contract-tests");
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(path.join(parent, "case-"));
	const ready = Promise.withResolvers<{ selected: boolean; current: string | null }>();
	const events: string[] = [];
	let output = "";
	let target: Process | null = null;
	let deadline: NodeJS.Timeout | undefined;
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		response.setHeader("Content-Type", "application/json");
		if (url.pathname === "/v1/models") {
			events.push("discovery");
			response.end(JSON.stringify({ data: [{ id: "gpt-4o-mini", object: "model", owned_by: "study" }] }));
		} else if (url.pathname === "/session-start") {
			events.push("session-start");
			response.end("{}");
		} else if (url.pathname === "/model-ready") {
			events.push("model-ready");
			response.end("{}");
			ready.resolve({
				selected: url.searchParams.get("selected") === "true",
				current: url.searchParams.get("current"),
			});
		} else {
			response.writeHead(404).end("{}");
		}
	});
	try {
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Discovery server did not bind a TCP port");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const home = path.join(root, "home");
		const config = path.join(root, "config");
		const agent = path.join(config, "profiles", "default", "agent");
		const project = path.join(root, "project");
		await mkdir(agent, { recursive: true });
		await mkdir(project);
		await mkdir(home);
		await writeFile(path.join(config, "config.yml"), "onboardingVersion: 1\n");
		await writeFile(
			path.join(agent, "config.yml"),
			JSON.stringify({
				modelRoles: { default: "startup-study/gpt-4o" },
				startup: { quiet: true, showSplash: false, checkUpdate: false, autoUpdate: false },
			}),
		);
		await writeFile(
			path.join(agent, "models.yml"),
			JSON.stringify({
				providers: {
					"startup-study": {
						baseUrl: `${baseUrl}/v1`,
						apiKey: "synthetic-startup-key",
						api: "openai-completions",
						discovery: { type: "openai-models-list" },
						models: [
							{
								id: "gpt-4o",
								name: "Static Study Model",
								reasoning: false,
								input: ["text"],
								contextWindow: 128000,
								maxTokens: 8192,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		);
		const extension = path.join(root, "observe-refresh.ts");
		await writeFile(
			extension,
			`import { setTimeout as delay } from "node:timers/promises";
export default function(api) {
  api.on("session_start", async (_event, ctx) => {
    await fetch(${JSON.stringify(`${baseUrl}/session-start`)});
    void (async () => {
      const expires = Date.now() + 15000;
      while (Date.now() < expires) {
        const model = ctx.modelRegistry.find("startup-study", "gpt-4o-mini");
        if (model) {
          const selected = await api.setModel(model);
          const url = new URL(${JSON.stringify(`${baseUrl}/model-ready`)});
          url.searchParams.set("selected", String(selected));
          url.searchParams.set("current", ctx.model?.id ?? "");
          await fetch(url);
          return;
        }
        await delay(20);
      }
    })();
  });
}
`,
		);
		const env: Record<string, string | undefined> = {
			PATH: process.env.PATH,
			...BUN_CACHE_ENV,
			HOME: home,
			NODE_ENV: "production",
			VEYYON_CONFIG_DIR: config,
			VEYYON_PROFILE: "",
			VEYYON_FIRST_FRAME_CACHE: path.join(root, "frame.json"),
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			XDG_DATA_HOME: path.join(home, ".local/share"),
			XDG_STATE_HOME: path.join(home, ".local/state"),
			TERM: "xterm-256color",
			LANG: "C.UTF-8",
		};
		denyHostProviderAccess(env);
		const wrapper = ptyWrapper(
			process.execPath,
			[
				path.join(repoRoot, "packages/coding-agent/src/cli.ts"),
				"--no-session",
				"--model",
				"startup-study/gpt-4o",
				"--extension",
				extension,
			],
			{ columns: 120, rows: 40 },
		);
		const started = performance.now();
		const child = spawn(wrapper.command, wrapper.args, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
		child.once("error", ready.reject);
		child.once("close", (code, signal) =>
			ready.reject(new Error(`CLI exited before discovery (${signal ?? code}): ${output}`)),
		);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output = (output + chunk).slice(-8000);
		});
		child.stderr.on("data", (chunk: string) => {
			output = (output + chunk).slice(-8000);
		});
		if (child.pid) target = Process.fromPid(child.pid);
		deadline = setTimeout(
			() => ready.reject(new Error(`Discovery did not finish: ${events.join(", ")}\n${output}`)),
			20000,
		);
		expect(await ready.promise).toEqual({ selected: true, current: "gpt-4o-mini" });
		expect(events.indexOf("session-start")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("discovery")).toBeGreaterThan(events.indexOf("session-start"));
		expect(events.indexOf("model-ready")).toBeGreaterThan(events.indexOf("discovery"));
		expect(performance.now() - started).toBeLessThan(20000);
	} finally {
		clearTimeout(deadline);
		if (target) expect(await target.terminate({ gracefulMs: 500, timeoutMs: 2000 })).toBe(true);
		const closed = Promise.withResolvers<void>();
		server.close(error => {
			if (error) closed.reject(error);
			else closed.resolve();
		});
		server.closeAllConnections();
		await closed.promise;
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
