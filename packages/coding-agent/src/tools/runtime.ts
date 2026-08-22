import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { isRecord, prompt } from "@veyyon/utils";
import { type } from "arktype";
import type { EvalToolDetails } from "../eval/types";
import { toolsPrompts } from "../prompts/tools/rows";
import { discoverAgents } from "../task/discovery";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { type EnabledSubagentCatalog, resolveEnabledSubagents } from "../task/subagent-settings";
import type { AgentDefinition } from "../task/types";
import type { ToolSession } from ".";
import {
	describeCodeField,
	describeLanguageField,
	EVAL_LANGUAGE_ORDER,
	enabledEvalLanguages,
	evalCellCommonFields,
	EvalTool,
	summarizeEvalLanguages,
	type EvalLanguageToken,
	type EvalToolOptions,
	type EvalToolParams,
} from "./eval";
import { resolveEvalBackends } from "./eval-backends";
import { LaunchTool, type LaunchParams, type LaunchToolDetails } from "./launch";
import { ToolError } from "./tool-errors";

const runtimeStartSchema = type({
	op: "'start'",
	name: type("string <= 48").describe("stable project-scoped launch name"),
	application: type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeout?": type("number > 0").describe("seconds to wait; default 30"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last veyyon client exiting; default false"),
	"detached?": type("boolean").describe(
		"start: survive every veyyon and broker exit; implies persist and disables PTY input",
	),
});

const runtimeListSchema = type({
	op: "'list'",
});

const runtimeLogsSchema = type({
	op: "'logs'",
	name: type("string <= 48").describe("stable project-scoped launch name"),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs: output cursor returned by an earlier call"),
	"timeout?": type("number > 0").describe("logs: max seconds; default 30"),
});

const runtimeWaitSchema = type({
	op: "'wait'",
	name: type("string <= 48").describe("stable project-scoped launch name"),
	"for?": type("'ready' | 'exit'").describe("wait: lifecycle condition; default exit"),
	"pattern?": type("string > 0").describe("wait: output regex; takes precedence over for"),
	"timeout?": type("number > 0").describe("wait: max seconds; default 30"),
});

const runtimeSendSchema = type({
	op: "'send'",
	name: type("string <= 48").describe("stable project-scoped launch name"),
	"text?": type("string > 0").describe("send: stdin text"),
	"enter?": type("boolean").describe("send: append Enter after text; default true"),
	"keys?": type("string[]").describe("send: terminal keys after text"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe("send: process-tree signal"),
});

const runtimeStopSchema = type({
	op: "'stop'",
	name: type("string <= 48").describe("stable project-scoped launch name"),
	"timeout?": type("number > 0").describe("stop: max seconds; default 5"),
});

const runtimeRestartSchema = type({
	op: "'restart'",
	name: type("string <= 48").describe("stable project-scoped launch name"),
});

const runtimeDescribeSchema = type({
	op: "'describe'",
	name: type("string <= 48").describe("stable project-scoped launch name"),
});

const runtimeDisabledSchema = type({
	op: type("'disabled'").describe("runtime operations are disabled in this session"),
});

function buildRuntimeSchema(langs: readonly EvalLanguageToken[], launchEnabled = true) {
	const hasEval = langs.length > 0;
	if (!hasEval && !launchEnabled) {
		return runtimeDisabledSchema;
	}

	const launchUnion = runtimeStartSchema
		.or(runtimeListSchema)
		.or(runtimeLogsSchema)
		.or(runtimeWaitSchema)
		.or(runtimeSendSchema)
		.or(runtimeStopSchema)
		.or(runtimeRestartSchema)
		.or(runtimeDescribeSchema);

	if (!hasEval) {
		return launchUnion;
	}

	const execSchema = type({
		op: "'exec'",
		language: type.enumerated(...langs).describe(describeLanguageField(langs)),
		code: type("string").describe(describeCodeField(langs)),
		...evalCellCommonFields,
	});

	if (!launchEnabled) {
		return execSchema;
	}

	return execSchema.or(launchUnion);
}

export const runtimeSchema = buildRuntimeSchema(EVAL_LANGUAGE_ORDER, true);

export type RuntimeToolParams = typeof runtimeSchema.infer;

export interface RuntimeEvalDetails {
	target: "eval";
	op: "exec";
	details?: EvalToolDetails;
	eval?: EvalToolDetails;
}

export interface RuntimeLaunchDetails {
	target: "launch";
	op: LaunchParams["op"];
	details: LaunchToolDetails;
	launch: LaunchToolDetails;
}

export type RuntimeToolDetails = RuntimeEvalDetails | RuntimeLaunchDetails;

export interface RuntimeToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
	rb?: boolean;
	jl?: boolean;
	launch?: boolean;
	spawns?: boolean | string | null;
	effectiveAgents?: readonly string[];
	effectiveDefaultAgent?: string;
}

export function getRuntimeToolDescription(options: RuntimeToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	const rb = options.rb ?? false;
	const jl = options.jl ?? false;
	const launch = options.launch ?? true;
	const hasEval = py || js || rb || jl;
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	const hasEffectiveCatalog = options.effectiveAgents !== undefined;
	const effectiveAgents = options.effectiveAgents ?? [];
	const spawns = hasEffectiveCatalog ? effectiveAgents.length > 0 : spawnPolicy.enabled;
	const spawnDefaultAgent = hasEffectiveCatalog ? options.effectiveDefaultAgent : spawnPolicy.defaultAgent;
	const spawnAllowedAgentsText = hasEffectiveCatalog
		? effectiveAgents.map(agent => `\`${agent}\``).join(", ")
		: spawnPolicy.allowedPromptText;
	return prompt.render(toolsPrompts["tools/runtime"].text, {
		py,
		js,
		rb,
		jl,
		launch,
		hasEval,
		spawns,
		spawnDefaultAgent,
		hasSpawnDefaultAgent: spawnDefaultAgent !== undefined,
		spawnAllowedAgentsText,
		spawnAgentListLabel: hasEffectiveCatalog ? "Enabled agents" : "Allowed agents",
	});
}

export interface RuntimeToolOptions {
	evalOptions?: EvalToolOptions;
	discoveredAgents?: readonly AgentDefinition[];
	evalTool?: EvalTool;
	launchTool?: LaunchTool;
}

/**
 * Unified runtime tool composing kernel execution (eval) and process supervision (launch).
 */
export class RuntimeTool implements AgentTool<typeof runtimeSchema, RuntimeToolDetails> {
	readonly name = "runtime";
	readonly label = "Runtime";
	readonly loadMode = "essential";
	readonly strict = true;

	readonly #evalTool: EvalTool;
	readonly #launchTool: LaunchTool;
	readonly #discoveredAgents: readonly AgentDefinition[];

	#paramsKey?: string;
	#cachedParams?: typeof runtimeSchema;

	get summary(): string {
		const langs = this.#enabledLanguages();
		const launch = this.#isLaunchEnabled();
		if (langs.length > 0 && launch) {
			return "Execute persistent code evaluation cells or supervise long-running processes";
		}
		if (langs.length > 0) {
			return summarizeEvalLanguages(langs);
		}
		if (launch) {
			return "Supervise a shared project process that does not end on its own";
		}
		return "Runtime operations (eval/launch)";
	}

	get parameters(): typeof runtimeSchema {
		const langs = this.#enabledLanguages();
		const launch = this.#isLaunchEnabled();
		if (langs.length === EVAL_LANGUAGE_ORDER.length && launch) return runtimeSchema;
		const key = `${langs.join(",")};launch:${launch}`;
		if (this.#paramsKey !== key) {
			this.#cachedParams = buildRuntimeSchema(langs, launch) as unknown as typeof runtimeSchema;
			this.#paramsKey = key;
		}
		return this.#cachedParams ?? runtimeSchema;
	}

	get description(): string {
		if (!this.session) return getRuntimeToolDescription();
		const backends = resolveEvalBackends(this.session);
		const launch = this.#isLaunchEnabled();
		const catalog = this.#enabledSubagents();
		return getRuntimeToolDescription({
			py: backends.python,
			js: backends.js,
			rb: backends.ruby,
			jl: backends.julia,
			launch,
			effectiveAgents: catalog.agents.map(agent => agent.name),
			effectiveDefaultAgent: catalog.defaultAgent,
		});
	}

	readonly approval = (args: unknown): ToolApprovalDecision => {
		if (isRecord(args) && typeof args.op === "string") {
			switch (args.op) {
				case "list":
				case "logs":
				case "wait":
				case "describe":
					return "read";
				default:
					return "exec";
			}
		}
		return "exec";
	};

	readonly formatApprovalDetails = (args: unknown): string | string[] | undefined => {
		if (!isRecord(args) || typeof args.op !== "string") {
			return undefined;
		}
		if (args.op === "exec") {
			const evalParams: Partial<EvalToolParams> = {
				language: typeof args.language === "string" ? (args.language as EvalToolParams["language"]) : undefined,
				code: typeof args.code === "string" ? args.code : undefined,
				title: typeof args.title === "string" ? args.title : undefined,
				timeout: typeof args.timeout === "number" ? args.timeout : undefined,
				reset: typeof args.reset === "boolean" ? args.reset : undefined,
			};
			return this.#evalTool.formatApprovalDetails?.(evalParams);
		}
		if (args.op === "start") {
			const lines: string[] = [];
			if (typeof args.name === "string") lines.push(`Name: ${args.name}`);
			if (typeof args.application === "string") lines.push(`Application: ${args.application}`);
			if (Array.isArray(args.args) && args.args.length > 0) lines.push(`Args: ${args.args.join(" ")}`);
			if (typeof args.cwd === "string") lines.push(`Cwd: ${args.cwd}`);
			return lines.length > 0 ? lines : undefined;
		}
		return undefined;
	};

	readonly concurrency = (args: Partial<RuntimeToolParams>): "shared" | "exclusive" => {
		return args.op === "exec" ? "exclusive" : "shared";
	};

	readonly intent = (args: Partial<RuntimeToolParams>): string | undefined => {
		if (args.op === "exec") {
			const evalParams: Partial<EvalToolParams> = {
				language: "language" in args && typeof args.language === "string" ? args.language : undefined,
				title: "title" in args && typeof args.title === "string" ? args.title : undefined,
			};
			return this.#evalTool.intent?.(evalParams);
		}
		if (args.op) {
			const target = "name" in args && typeof args.name === "string"
				? args.name
				: "application" in args && typeof args.application === "string"
					? args.application
					: undefined;
			return target ? `launch ${args.op} ${target}` : `launch ${args.op}`;
		}
		return undefined;
	};

	static readonly #ALL_EXAMPLES: readonly ToolExample<RuntimeToolParams>[] = [
		{
			caption: "Run Python code cell",
			call: {
				op: "exec",
				language: "py",
				title: "imports",
				code: "import json\nfrom pathlib import Path",
			},
		},
		{
			caption: "Second call — reuse previous state",
			call: {
				op: "exec",
				language: "py",
				title: "load config",
				code: "data = json.loads(read('package.json'))\ndisplay(data)",
			},
		},
		{
			caption: "Start a dev server and wait for its log banner and port",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeout: 30 },
			},
		},
		{
			caption: "Follow output after a cursor",
			call: {
				op: "logs",
				name: "web",
				follow: true,
				cursor: 1842,
				timeout: 30,
			},
		},
	];

	get examples(): readonly ToolExample<RuntimeToolParams>[] {
		const langs = this.#enabledLanguages();
		const launch = this.#isLaunchEnabled();
		return RuntimeTool.#ALL_EXAMPLES.filter(ex => {
			if ("call" in ex && ex.call.op === "exec") {
				return langs.includes(ex.call.language as EvalLanguageToken);
			}
			return launch;
		});
	}

	#enabledLanguages(): EvalLanguageToken[] {
		return this.session ? enabledEvalLanguages(resolveEvalBackends(this.session)) : ["py", "js"];
	}

	#isLaunchEnabled(): boolean {
		return this.session ? (this.session.settings.get("launch.enabled") ?? true) : true;
	}

	#enabledSubagents(): EnabledSubagentCatalog {
		if (!this.session) {
			throw new ToolError("Runtime tool requires a session to resolve enabled subagents");
		}
		return resolveEnabledSubagents({
			settings: this.session.settings,
			agents: this.#discoveredAgents,
			parentSpawns: this.session.getSessionSpawns?.() ?? "*",
		});
	}

	constructor(
		private readonly session: ToolSession,
		options?: RuntimeToolOptions,
	) {
		this.#discoveredAgents = options?.discoveredAgents ?? [];
		const evalOpts: EvalToolOptions = options?.evalOptions ?? {
			discoveredAgents: this.#discoveredAgents,
		};
		this.#evalTool = options?.evalTool ?? new EvalTool(session, evalOpts);
		this.#launchTool = options?.launchTool ?? new LaunchTool(session);
	}

	static async create(session: ToolSession): Promise<RuntimeTool> {
		const { agents } = await discoverAgents(session.cwd);
		const evalTool = new EvalTool(session, { discoveredAgents: agents });
		const launchTool = new LaunchTool(session);
		return new RuntimeTool(session, { discoveredAgents: agents, evalTool, launchTool });
	}

	async execute(
		toolCallId: string,
		params: RuntimeToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<RuntimeToolDetails, typeof runtimeSchema>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<RuntimeToolDetails>> {
		if (params.op === "exec") {
			const langs = this.#enabledLanguages();
			if (langs.length === 0) {
				throw new ToolError("Kernel execution (exec) is disabled in this session");
			}
			if (!params.language) {
				throw new ToolError("exec requires language");
			}
			if (!langs.includes(params.language)) {
				throw new ToolError(`Language "${params.language}" is not enabled in this session`);
			}
			if (typeof params.code !== "string") {
				throw new ToolError("exec requires code");
			}
			const evalParams: EvalToolParams = {
				language: params.language,
				code: params.code,
				title: params.title,
				timeout: params.timeout,
				reset: params.reset,
			};
			const evalOnUpdate: AgentToolUpdateCallback<EvalToolDetails | undefined> = onUpdate
				? update => {
						onUpdate({
							content: update.content,
							details: {
								target: "eval",
								op: "exec",
								details: update.details,
								eval: update.details,
							},
						});
					}
				: undefined;

			const result = await this.#evalTool.execute(toolCallId, evalParams, signal, evalOnUpdate, context);
			return {
				content: result.content,
				details: {
					target: "eval",
					op: "exec",
					details: result.details,
					eval: result.details,
				},
			};
		}

		if (
			params.op === "start" ||
			params.op === "list" ||
			params.op === "logs" ||
			params.op === "wait" ||
			params.op === "send" ||
			params.op === "stop" ||
			params.op === "restart" ||
			params.op === "describe"
		) {
			if (!this.#isLaunchEnabled()) {
				throw new ToolError(`Process supervision (${params.op}) is disabled in this session`);
			}
			const launchParams: LaunchParams = {
				op: params.op,
				name: "name" in params ? params.name : undefined,
				application: "application" in params ? params.application : undefined,
				args: "args" in params ? params.args : undefined,
				env: "env" in params ? params.env : undefined,
				cwd: "cwd" in params ? params.cwd : undefined,
				pty: "pty" in params ? params.pty : undefined,
				ready: "ready" in params ? params.ready : undefined,
				restart: "restart" in params ? params.restart : undefined,
				persist: "persist" in params ? params.persist : undefined,
				detached: "detached" in params ? params.detached : undefined,
				lines: "lines" in params ? params.lines : undefined,
				head: "head" in params ? params.head : undefined,
				grep: "grep" in params ? params.grep : undefined,
				follow: "follow" in params ? params.follow : undefined,
				cursor: "cursor" in params ? params.cursor : undefined,
				for: "for" in params ? params.for : undefined,
				pattern: "pattern" in params ? params.pattern : undefined,
				text: "text" in params ? params.text : undefined,
				enter: "enter" in params ? params.enter : undefined,
				keys: "keys" in params ? params.keys : undefined,
				signal: "signal" in params ? params.signal : undefined,
				timeout: "timeout" in params ? params.timeout : undefined,
			};
			const launchOnUpdate: AgentToolUpdateCallback<LaunchToolDetails> = onUpdate
				? update => {
						onUpdate({
							content: update.content,
							details: {
								target: "launch",
								op: params.op as LaunchParams["op"],
								details: update.details,
								launch: update.details,
							},
						});
					}
				: undefined;

			const result = await this.#launchTool.execute(toolCallId, launchParams, signal, launchOnUpdate, context);
			return {
				content: result.content,
				details: {
					target: "launch",
					op: params.op,
					details: result.details,
					launch: result.details,
				},
			};
		}

		const unhandledOp = typeof params === "object" && params !== null && "op" in params ? String(params.op) : "unknown";
		throw new ToolError(`Unsupported runtime operation: ${unhandledOp}`);
	}
}
