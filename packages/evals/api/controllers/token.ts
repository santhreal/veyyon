/**
 * GET /api/token controller.
 */
import type { ServerContext } from "../context";

export function getTokenController(ctx: ServerContext): Response {
	return Response.json({ token: ctx.token });
}
