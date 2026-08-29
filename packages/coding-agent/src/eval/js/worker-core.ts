import { ToolError } from "../../tools/tool-errors";
import { JsRuntime, type RuntimeHooks } from "./shared/runtime";
import type { ActiveRun, RunResult, WorkerCoreOptions } from "./worker-core-helpers";

import { errorFromPayload, errorPayload, foldFloatingRejections, RECENT_CELL_FILES_MAX } from "./worker-core-helpers";
import type { EvalWorkerInbound, EvalWorkerTransport, SessionSnapshot, ToolReply } from "./worker-protocol";

export class WorkerCore {
	#transport: EvalWorkerTransport;
	#runtime: JsRuntime | null = null;
	#runs = new Map<string, ActiveRun>();
	#recentCellFiles = new Set<string>();
	#unsubscribe: () => void;
	#uninstallRejectionGuard: () => void;
	#options: WorkerCoreOptions;

	constructor(transport: EvalWorkerTransport, options: WorkerCoreOptions) {
		this.#transport = transport;
		this.#options = options;
		this.#unsubscribe = transport.onMessage(msg => this.#handle(msg));
		this.#uninstallRejectionGuard = this.#installRejectionGuard();
	}

	#installRejectionGuard(): () => void {
		if (this.#options.interceptUnhandledRejections) {
			return this.#options.interceptUnhandledRejections(reason => this.#consumeRejection(reason));
		}
		const onRejection = (reason: unknown): void => {
			if (this.#consumeRejection(reason)) return;
			setTimeout(() => {
				throw reason;
			}, 0);
		};
		process.on("unhandledRejection", onRejection);
		return () => {
			process.off("unhandledRejection", onRejection);
		};
	}

	#consumeRejection(reason: unknown): boolean {
		const stack = reason instanceof Error && typeof reason.stack === "string" ? reason.stack : undefined;
		if (stack) {
			let owner: ActiveRun | undefined;
			let ownerIndex = -1;
			for (const run of this.#runs.values()) {
				const index = stack.lastIndexOf(run.filename);
				if (index > ownerIndex) {
					ownerIndex = index;
					owner = run;
				}
			}
			if (owner) {
				owner.floatingRejections.push(reason);
				return true;
			}
			let recent: string | undefined;
			let recentIndex = -1;
			for (const filename of this.#recentCellFiles) {
				const index = stack.lastIndexOf(filename);
				if (index > recentIndex) {
					recentIndex = index;
					recent = filename;
				}
			}
			if (recent) {
				this.#transport.send({
					type: "log",
					level: "warn",
					msg: "Unhandled rejection from a finished eval cell (missing await?)",
					meta: { filename: recent, error: errorPayload(reason) },
				});
				return true;
			}
		}
		if (this.#options.mode === "isolated" && this.#runs.size > 0) {
			if (this.#runs.size === 1) {
				const only = this.#runs.values().next().value;
				only?.floatingRejections.push(reason);
				return true;
			}
			this.#transport.send({
				type: "log",
				level: "warn",
				msg: "Unhandled rejection during concurrent eval runs; cannot attribute to a cell",
				meta: { error: errorPayload(reason) },
			});
			return true;
		}
		return false;
	}

	#handle(msg: EvalWorkerInbound): void {
		switch (msg.type) {
			case "init":
				try {
					this.#ensureRuntime(msg.snapshot);
					this.#transport.send({ type: "ready" });
				} catch (error) {
					this.#transport.send({ type: "init-failed", error: errorPayload(error) });
				}
				return;
			case "run":
				void this.#runOne(msg.runId, msg.code, msg.filename, msg.snapshot);
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				this.#close();
				return;
		}
	}

	#ensureRuntime(snapshot: SessionSnapshot, currentRunId?: string): JsRuntime {
		this.#syncProcessCwd(snapshot.cwd, currentRunId);
		if (this.#runtime) {
			this.#runtime.setCwd(snapshot.cwd);
			return this.#runtime;
		}
		this.#runtime = new JsRuntime({
			initialCwd: snapshot.cwd,
			sessionId: snapshot.sessionId,
			localRoots: snapshot.localRoots,
			artifactsDir: snapshot.artifactsDir,
		});
		return this.#runtime;
	}

	#syncProcessCwd(cwd: string, currentRunId?: string): void {
		if (this.#options.mode !== "isolated" || !this.#options.chdir) return;
		try {
			if (process.cwd() === cwd) return;
		} catch {}
		for (const runId of this.#runs.keys()) {
			if (runId === currentRunId) continue;
			this.#transport.send({
				type: "log",
				level: "warn",
				msg: "JS eval subprocess kept its process cwd: other cells are mid-run",
				meta: { cwd },
			});
			return;
		}
		try {
			this.#options.chdir(cwd);
		} catch (error) {
			this.#transport.send({
				type: "log",
				level: "warn",
				msg: "JS eval subprocess could not enter the session cwd",
				meta: { cwd, error: errorPayload(error) },
			});
		}
	}

	async #runOne(runId: string, code: string, filename: string, snapshot: SessionSnapshot): Promise<void> {
		const active: ActiveRun = { runId, filename, pendingTools: new Map(), floatingRejections: [] };
		this.#runs.set(runId, active);
		const hooks: RuntimeHooks = {
			onText: chunk => this.#transport.send({ type: "text", runId, chunk }),
			onDisplay: output => this.#transport.send({ type: "display", runId, output }),
			callTool: (name, args) => this.#callTool(active, name, args),
		};
		let result: RunResult;
		try {
			const runtime = this.#ensureRuntime(snapshot, runId);
			runtime.setCwd(snapshot.cwd);
			const value = await runtime.run(code, filename, hooks, { runId, cwd: snapshot.cwd });
			runtime.displayValue(value, hooks);
			result = { type: "result", runId, ok: true };
		} catch (error) {
			result = { type: "result", runId, ok: false, error: errorPayload(error) };
		}
		try {
			await Bun.sleep(0);
			result = foldFloatingRejections(active, result, hooks);
		} finally {
			this.#runs.delete(runId);
			this.#rememberCellFile(filename);
			this.#transport.send(result);
		}
	}

	#rememberCellFile(filename: string): void {
		this.#recentCellFiles.delete(filename);
		this.#recentCellFiles.add(filename);
		if (this.#recentCellFiles.size > RECENT_CELL_FILES_MAX) {
			const oldest = this.#recentCellFiles.values().next().value;
			if (oldest !== undefined) this.#recentCellFiles.delete(oldest);
		}
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tc-${active.runId}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { runId: active.runId, resolve, reject });
		try {
			this.#transport.send({ type: "tool-call", id, runId: active.runId, name, args });
		} catch (error) {
			active.pendingTools.delete(id);
			reject(error);
		}
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		for (const active of this.#runs.values()) {
			const pending = active.pendingTools.get(id);
			if (!pending) continue;
			active.pendingTools.delete(id);
			if (reply.ok) pending.resolve(reply.value);
			else pending.reject(errorFromPayload(reply.error));
			return;
		}
	}

	#close(): void {
		for (const active of this.#runs.values()) {
			for (const pending of active.pendingTools.values()) {
				pending.reject(new ToolError("JS worker closed"));
			}
			active.pendingTools.clear();
		}
		this.#runs.clear();
		this.#runtime?.dispose?.();
		this.#runtime = null;
		this.#transport.send({ type: "closed" });
		this.#uninstallRejectionGuard();
		this.#unsubscribe();
		this.#transport.close();
	}

	dispose(): void {
		for (const active of this.#runs.values()) {
			for (const pending of active.pendingTools.values()) {
				pending.reject(new ToolError("JS worker closed"));
			}
			active.pendingTools.clear();
		}
		this.#runs.clear();
		this.#runtime?.dispose?.();
		this.#runtime = null;
		this.#uninstallRejectionGuard();
		this.#unsubscribe();
		try {
			this.#transport.close();
		} catch {}
	}
}
