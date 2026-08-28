/**
 * GET /api/benchmarks controller.
 */
import { listBenchmarkDefinitions } from "../../store/benchmarks";
import type { ServerContext } from "../context";

export function getBenchmarksController(_ctx: ServerContext): Response {
	return Response.json(listBenchmarkDefinitions());
}
