#!/usr/bin/env bun
/**
 * evals manager server: REST + SSE API over the run store, static web
 * dashboard, and a launcher that spawns the CLI runner as a managed child.
 *
 *   bun src/server/main.ts [--port 4700] [--jobs-dir <path>]
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { Server } from "bun";
import { experimentOf, knownExperimentIdsWith } from "../manager/experiments";
import { RunStore } from "../manager/store";
import { harborJobsDir } from "../paths";
import indexHtml from "../web/index.html";
import {
	type AddArmRequest,
	type CreateExperimentRequest,
	type ExperimentMetaUpdate,
	type LaunchRequest,
	type RouteDescriptor,
	SERVER_ROUTES,
} from "../wire";
import type { ServerContext } from "./context";
import { resolveArmLaunch } from "./controllers/experiments";
import { RequestRouter } from "./router";
import { RunnerManager } from "./runner";
import { SseStream } from "./sse";

export type { AddArmRequest, CreateExperimentRequest, ExperimentMetaUpdate, RouteDescriptor };
export { resolveArmLaunch, SERVER_ROUTES };

function parseServerArgs(argv: string[]): { port: number; host: string; jobsDir: string; token?: string } {
	let port = 4700;
	let host = "127.0.0.1";
	let jobsDir = harborJobsDir();
	let token: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port" && argv[i + 1]) port = Number(argv[++i]);
		else if (argv[i] === "--host" && argv[i + 1]) host = argv[++i];
		else if (argv[i] === "--jobs-dir" && argv[i + 1]) jobsDir = path.resolve(argv[++i]);
		else if (argv[i] === "--token" && argv[i + 1]) token = argv[++i];
	}
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");
	return { port, host, jobsDir, token };
}

export class ManagerServer {
	static readonly routes: readonly RouteDescriptor[] = SERVER_ROUTES;
	readonly #store: RunStore;
	readonly #sse = new SseStream();
	readonly #runner: RunnerManager;
	readonly #router = new RequestRouter();
	readonly #context: ServerContext;
	#server: Server<undefined> | null = null;
	readonly #token: string;
	readonly jobsDir: string;

	constructor(jobsDir: string, dbPath?: string, token?: string) {
		this.jobsDir = jobsDir;
		this.#store = new RunStore(jobsDir, dbPath);
		this.#token = token ?? process.env.VEYYON_EVALS_TOKEN ?? crypto.randomUUID().replace(/-/g, "");
		this.#runner = new RunnerManager(jobsDir, this.#store, () => this.#sse.tick(this.#store));
		this.#context = {
			store: this.#store,
			jobsDir: this.jobsDir,
			token: this.#token,
			sse: this.#sse,
			runner: this.#runner,
			onTick: () => this.#sse.tick(this.#store),
		};
	}

	get token(): string {
		return this.#token;
	}

	get store(): RunStore {
		return this.#store;
	}

	handle(request: Request): Promise<Response> {
		return this.#router.dispatch(this.#context, request);
	}

	start(port: number, host = "127.0.0.1"): Server<undefined> {
		this.#store.discover();
		this.#store.syncAll();
		this.#sse.startHeartbeat(this.#store, 2000);
		this.#server = Bun.serve({
			port,
			hostname: host,
			idleTimeout: 0,
			routes: { "/": indexHtml },
			development: process.env.NODE_ENV !== "production" && { hmr: true },
			fetch: request => this.handle(request),
		});
		return this.#server;
	}

	async stop(): Promise<void> {
		this.#runner.stop();
		this.#sse.stop();
		this.#server?.stop(true);
		this.#store.close();
	}

	launch(request: LaunchRequest): { jobName: string; pid: number } {
		return this.#runner.launch(request);
	}

	resume(jobName: string, opts: { filterErrorTypes?: string[] } = {}): { jobName: string; pid: number } {
		return this.#runner.resume(jobName, opts);
	}

	createExperiment(req: CreateExperimentRequest): { id: string; goal: string } {
		const id = req.id?.trim() ?? "";
		if (!/^[A-Za-z0-9_.]+$/.test(id)) {
			throw new Error("experiment id must be a non-empty token of [A-Za-z0-9_.] (runs group as `<id>-<arm>`)");
		}
		const goal = req.goal ?? this.#store.getExperimentMeta(id)?.goal ?? "";
		this.#store.setExperimentGoal(id, goal);
		return { id, goal };
	}

	updateExperimentMeta(id: string, update: ExperimentMetaUpdate): { id: string; updatedRuns: string[] } {
		if (update.goal !== undefined) this.#store.setExperimentGoal(id, update.goal);
		const updatedRuns: string[] = [];
		for (const jobName in update.runs) {
			const run = this.#store.getRun(jobName);
			if (!run || experimentOf(run, knownExperimentIdsWith(this.#store, id)) !== id) continue;
			if (this.#store.setRunMeta(jobName, update.runs[jobName])) updatedRuns.push(jobName);
		}
		this.#sse.tick(this.#store);
		return { id, updatedRuns };
	}

	deleteExperiment(id: string): { id: string; deletedRuns: string[] } | null {
		const runs = this.#store.listRuns().filter(r => experimentOf(r, knownExperimentIdsWith(this.#store, id)) === id);
		if (runs.length === 0 && !this.#store.getExperimentMeta(id)) return null;
		const live = runs.filter(r => this.#runner.isLive(r));
		if (live.length > 0) {
			throw new Error(
				`experiment ${id} has running arms (${live.map(r => r.jobName).join(", ")}); cancel them first`,
			);
		}
		for (const run of runs) this.#runner.destroyRun(run.jobName);
		this.#store.deleteExperimentMeta(id);
		this.#sse.tick(this.#store);
		return { id, deletedRuns: runs.map(r => r.jobName) };
	}

	deleteRun(jobName: string): boolean {
		return this.#runner.deleteRun(jobName);
	}

	addArm(experimentId: string, req: AddArmRequest): { jobName: string; pid: number } {
		return this.launch(resolveArmLaunch(this.#store, experimentId, req));
	}

	cancel(jobName: string): { jobName: string; cancelled: boolean } {
		return this.#runner.cancel(jobName);
	}
}

function isDevStreamTeardown(err: unknown): boolean {
	return err instanceof Error && (err as Error & { code?: string }).code === "ERR_STREAM_RELEASE_LOCK";
}

if (import.meta.main) {
	const globalHost = globalThis as typeof globalThis & {
		__evalsServer?: ManagerServer;
		__evalsHooks?: boolean;
	};
	await globalHost.__evalsServer?.stop();
	const { port, host, jobsDir, token } = parseServerArgs(process.argv.slice(2));
	const manager = new ManagerServer(jobsDir, undefined, token);
	globalHost.__evalsServer = manager;
	const server = manager.start(port, host);
	process.stdout.write(`evals manager listening on http://${host}:${server.port} (jobs: ${jobsDir})\n`);
	if (!globalHost.__evalsHooks) {
		globalHost.__evalsHooks = true;
		const shutdown = async () => {
			await globalHost.__evalsServer?.stop();
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
		process.on("unhandledRejection", err => {
			if (isDevStreamTeardown(err)) {
				process.stderr.write("ignored dev-server stream teardown (ERR_STREAM_RELEASE_LOCK)\n");
				return;
			}
			throw err;
		});
	}
}
