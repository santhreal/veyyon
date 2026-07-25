/**
 * `memory_edit`: update, forget, or invalidate a stored memory.
 *
 * All three operations look the same in a JSON dump and mean different things:
 * `update` rewrites a memory, `forget` removes it, and `invalidate` marks it
 * superseded by another id. The last one is the one that needs both ids on
 * screen, because "which memory replaced it" is the whole point of the call.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, Note, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { normalizeWs, num, str, truncate } from "../util";

/** `forget` removes a memory, so it is the one that reads as destructive. */
function toneFor(op: string | null, isError: boolean | undefined): "ok" | "warn" | "err" {
	if (isError) return "err";
	return op === "forget" ? "warn" : "ok";
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const op = str(args.op);
	const id = str(args.id);
	const replacement = str(args.replacement_id);
	return (
		<>
			<Badge tone={toneFor(op, result?.isError)}>{op ?? "memory"}</Badge> {id && <span>{id}</span>}
			{replacement && <span> → {replacement}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const op = str(args.op);
	const id = str(args.id);
	const content = str(args.content);
	const importance = num(args.importance);
	const replacement = str(args.replacement_id);
	return (
		<>
			<Badges
				items={[
					<Badge key="op" tone={toneFor(op, result?.isError)}>
						{op ?? "memory"}
					</Badge>,
				]}
			/>
			<KvGrid>
				{id && <Kv k="id">{id}</Kv>}
				{replacement && <Kv k="replaced by">{replacement}</Kv>}
				{importance !== null && <Kv k="importance">{String(importance)}</Kv>}
			</KvGrid>
			{content && <Note>{truncate(normalizeWs(content), 400)}</Note>}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

export const memoryEditRenderer: ToolRenderer = { Summary, Body };
