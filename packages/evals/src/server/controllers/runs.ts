/**
 * Run controllers: listing, launching, detail inspection, cancellation, resumption,
 * and deletion of benchmark runs.
 */
import { experimentOf, knownExperimentIdsWith } from "../../manager/experiments";
import { InvalidLaunchRequestError, type LaunchRequest, parseLaunchRequest } from "../../wire";
import type { ServerContext } from "../context";

export function getRunsController(ctx: ServerContext, url: URL): Response {
	const experiment = url.searchParams.get("experiment");
	const status = url.searchParams.get("status");
	const benchmark = url.searchParams.get("benchmark");
	let runs = ctx.store.listRuns();
	if (experiment) {
		const registeredIds = knownExperimentIdsWith(ctx.store, experiment);
		runs = runs.filter(r => experimentOf(r, registeredIds) === experiment);
	}
	if (status) runs = runs.filter(r => r.status === status);
	if (benchmark) runs = runs.filter(r => r.benchmark === benchmark);
	return Response.json(runs);
}

export async function launchRunController(
	ctx: ServerContext,
	_url: URL,
	_params: Record<string, string>,
	request: Request,
): Promise<Response> {
	let body: LaunchRequest;
	try {
		body = parseLaunchRequest(await request.json().catch(() => null));
	} catch (error) {
		if (error instanceof InvalidLaunchRequestError) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
	const result = ctx.runner.launch(body);
	return Response.json(result, { status: 201 });
}

export function getRunDetailController(ctx: ServerContext, _url: URL, params: Record<string, string>): Response {
	const jobName = params.name;
	const run = ctx.store.syncRun(jobName);
	if (!run) return Response.json({ error: "run not found" }, { status: 404 });
	return Response.json({ run, traces: ctx.store.listTraces(jobName) });
}

export function deleteRunController(ctx: ServerContext, _url: URL, params: Record<string, string>): Response {
	const jobName = params.name;
	if (!ctx.runner.deleteRun(jobName)) return Response.json({ error: "run not found" }, { status: 404 });
	return Response.json({ jobName, deleted: true });
}

export function cancelRunController(ctx: ServerContext, _url: URL, params: Record<string, string>): Response {
	const jobName = params.name;
	const result = ctx.runner.cancel(jobName);
	return Response.json(result);
}

export async function resumeRunController(
	ctx: ServerContext,
	_url: URL,
	params: Record<string, string>,
	request: Request,
): Promise<Response> {
	const jobName = params.name;
	const body = (await request.json().catch(() => ({}))) as { filterErrorTypes?: string[] };
	const result = ctx.runner.resume(jobName, body);
	return Response.json(result, { status: 201 });
}
