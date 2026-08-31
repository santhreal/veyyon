/**
 * Experiment controllers: experiment listing, detail, creation, metadata updates,
 * deletion, and arm launch configuration inheritance.
 */
import { buildExperiments, experimentDetail, experimentOf, knownExperimentIdsWith } from "../../store/experiments";
import type { RunRow, RunStore } from "../../store/sqlite";
import {
	ADD_ARM_SPEC,
	type AddArmRequest,
	CREATE_EXPERIMENT_SPEC,
	EXPERIMENT_META_UPDATE_SPEC,
	type LaunchRequest,
	parseRequestBody,
} from "../../engine/store-shapes";
import type { ServerContext } from "../context";

/**
 * Resolve the launch request for a new arm added to an existing experiment.
 * Inherits the experiment's benchmark, dataset, and exact task sample from a sibling arm
 * (its recorded `include`, else its observed trial tasks) so the arm is directly comparable.
 */
export function resolveArmLaunch(store: RunStore, experimentId: string, req: AddArmRequest): LaunchRequest {
	if (!req.arm || /[^\w.-]/.test(req.arm)) throw new Error("arm must be a non-empty [A-Za-z0-9_.-] token");
	if (!req.model) throw new Error("model is required");
	const registeredIds = knownExperimentIdsWith(store, experimentId);
	const siblings = store.listRuns().filter(r => experimentOf(r, registeredIds) === experimentId);
	if (siblings.length === 0) throw new Error(`experiment '${experimentId}' has no runs to inherit from`);

	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	const recordedInclude = (r: RunRow): string[] => strings((r.config as Partial<LaunchRequest>).include);
	const score = (r: RunRow): [number, number] => {
		const recorded = recordedInclude(r).length;
		return recorded > 0 ? [1, recorded] : [0, store.listTraces(r.jobName).length];
	};
	let template = siblings[0];
	let templateScore = score(template);
	for (const r of siblings.slice(1)) {
		const s = score(r);
		if (s[0] > templateScore[0] || (s[0] === templateScore[0] && s[1] > templateScore[1])) {
			[template, templateScore] = [r, s];
		}
	}
	const cfg = template.config as Partial<LaunchRequest>;
	const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
	const numberOr = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

	let include = req.include && req.include.length > 0 ? req.include : strings(cfg.include);
	if (include.length === 0) {
		const org = template.dataset.includes("/") ? `${template.dataset.split("/", 1)[0]}/` : "";
		include = [
			...new Set(
				store
					.listTraces(template.jobName)
					.map(t => t.task)
					.filter(Boolean)
					.map(task => (task.includes("/") ? task : `${org}${task}`)),
			),
		];
	}
	const jobName = `${experimentId}-${req.arm}`;
	if (store.getRun(jobName)) throw new Error(`arm '${req.arm}' already exists in '${experimentId}'`);
	return {
		benchmark: template.benchmark,
		model: req.model,
		dataset: template.dataset,
		include: include.length > 0 ? include : undefined,
		tasks: include.length > 0 ? include.length : numberOr(cfg.tasks),
		concurrency: numberOr(cfg.concurrency),
		timeoutMultiplier: numberOr(cfg.timeoutMultiplier),
		attempts: numberOr(cfg.attempts),
		agent: str(cfg.agent),
		webSearch: cfg.webSearch === true || undefined,
		prebuiltBinaries: cfg.prebuiltBinaries === true || undefined,
		jobName,
		experiment: experimentId,
		arm: req.arm,
		prewalk: req.prewalk,
		role: req.role,
		note: req.note,
		environment: cfg.environment === "docker" || cfg.environment === "apple-container" ? cfg.environment : undefined,
		extraArgs: req.extraArgs,
	};
}

export function getExperimentsController(ctx: ServerContext, url: URL): Response {
	const q = url.searchParams.get("q")?.toLowerCase() ?? "";
	const experiments = buildExperiments(ctx.store);
	return Response.json(
		q ? experiments.filter(e => e.id.toLowerCase().includes(q) || e.goal.toLowerCase().includes(q)) : experiments,
	);
}

export async function createExperimentController(
	ctx: ServerContext,
	_url: URL,
	_params: Record<string, string>,
	request: Request,
): Promise<Response> {
	const body = parseRequestBody(await request.json().catch(() => null), CREATE_EXPERIMENT_SPEC);
	const id = body.id.trim();
	const goal = body.goal ?? ctx.store.getExperimentMeta(id)?.goal ?? "";
	ctx.store.setExperimentGoal(id, goal);
	return Response.json({ id, goal }, { status: 201 });
}

export function getExperimentDetailController(ctx: ServerContext, _url: URL, params: Record<string, string>): Response {
	const id = params.id;
	const detail = experimentDetail(ctx.store, id);
	if (!detail) return Response.json({ error: "experiment not found" }, { status: 404 });
	return Response.json(detail);
}

export async function updateExperimentMetaController(
	ctx: ServerContext,
	_url: URL,
	params: Record<string, string>,
	request: Request,
): Promise<Response> {
	const id = params.id;
	const body = parseRequestBody(await request.json().catch(() => null), EXPERIMENT_META_UPDATE_SPEC);
	if (body.goal !== undefined) ctx.store.setExperimentGoal(id, body.goal);
	const updatedRuns: string[] = [];
	for (const jobName in body.runs) {
		const run = ctx.store.getRun(jobName);
		if (!run || experimentOf(run, knownExperimentIdsWith(ctx.store, id)) !== id) continue;
		if (ctx.store.setRunMeta(jobName, body.runs[jobName])) updatedRuns.push(jobName);
	}
	ctx.onTick();
	return Response.json({ id, updatedRuns });
}

export function deleteExperimentController(ctx: ServerContext, _url: URL, params: Record<string, string>): Response {
	const id = params.id;
	const runs = ctx.store.listRuns().filter(r => experimentOf(r, knownExperimentIdsWith(ctx.store, id)) === id);
	if (runs.length === 0 && !ctx.store.getExperimentMeta(id)) {
		return Response.json({ error: "experiment not found" }, { status: 404 });
	}
	const live = runs.filter(r => ctx.runner.isLive(r));
	if (live.length > 0) {
		throw new Error(`experiment ${id} has running arms (${live.map(r => r.jobName).join(", ")}); cancel them first`);
	}
	for (const run of runs) ctx.runner.destroyRun(run.jobName);
	ctx.store.deleteExperimentMeta(id);
	ctx.onTick();
	return Response.json({ id, deletedRuns: runs.map(r => r.jobName) });
}

export async function addArmController(
	ctx: ServerContext,
	_url: URL,
	params: Record<string, string>,
	request: Request,
): Promise<Response> {
	const id = params.id;
	const body = parseRequestBody(await request.json().catch(() => null), ADD_ARM_SPEC);
	const launchRequest = resolveArmLaunch(ctx.store, id, body);
	const result = ctx.runner.launch(launchRequest);
	return Response.json(result, { status: 201 });
}
