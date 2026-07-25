/**
 * `set_cwd`: re-root the session's working directory for the rest of the session.
 *
 * The move itself is one line, and the part worth reading is the RULE DELTA. A
 * re-root changes which `AGENTS.md` / `CLAUDE.md` files govern the session,
 * because they are found by walking up from the working directory, and a move
 * that silently swapped the governing rules looked exactly like one that changed
 * nothing. The terminal view already says so; without this renderer the web view
 * fell through to the generic JSON dump, where the same information was present
 * but unreadable.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, Note, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, num, str } from "../util";

interface RuleChange {
	previous: string | null;
	cwd: string | null;
	applied: string[];
	dropped: string[];
	unchanged: number | null;
}

/** Only the string entries, because `details` arrives as untrusted JSON. */
function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readChange({ result }: ToolRenderProps): RuleChange {
	const details = detailsRecord(result);
	return {
		previous: details ? str(details.previous) : null,
		cwd: details ? str(details.cwd) : null,
		applied: details ? stringList(details.rulesApplied) : [],
		dropped: details ? stringList(details.rulesDropped) : [],
		unchanged: details ? num(details.rulesUnchanged) : null,
	};
}

/**
 * The counts, not the names.
 *
 * A summary line is one line and a rule file path is long, so naming them here
 * would push the destination directory out of view. The body has the names.
 */
function ruleCountLabel(applied: number, dropped: number): string | null {
	if (applied === 0 && dropped === 0) return null;
	const counts = [applied > 0 ? `+${applied}` : "", dropped > 0 ? `-${dropped}` : ""].filter(Boolean).join(" ");
	return `${counts} ${applied + dropped === 1 ? "rule file" : "rule files"}`;
}

function Summary(props: ToolRenderProps): ReactNode {
	const { args, result } = props;
	const change = readChange(props);
	// Before the call settles there are no details, so fall back to what was
	// asked for. A running re-root should still say where it is going.
	const destination = change.cwd ?? str(args.path);
	const moved = change.previous !== null && change.cwd !== null && change.previous !== change.cwd;
	const rules = ruleCountLabel(change.applied.length, change.dropped.length);
	return (
		<>
			<Badge tone={result?.isError ? "err" : "ok"}>cwd</Badge>{" "}
			{destination ? <PathText path={destination} /> : <span>?</span>}
			{change.previous !== null && !moved && <span> (already here)</span>}
			{rules && <span> {rules}</span>}
		</>
	);
}

function Body(props: ToolRenderProps): ReactNode {
	const { result } = props;
	const change = readChange(props);
	const moved = change.previous !== null && change.cwd !== null && change.previous !== change.cwd;
	return (
		<>
			<Badges
				items={[
					<Badge key="move" tone={result?.isError ? "err" : moved ? "ok" : "warn"}>
						{moved ? "re-rooted" : "unchanged"}
					</Badge>,
				]}
			/>
			<KvGrid>
				{change.previous && <Kv k="from">{<PathText path={change.previous} />}</Kv>}
				{change.cwd && <Kv k="to">{<PathText path={change.cwd} />}</Kv>}
				{change.applied.map(path => (
					<Kv key={`applied:${path}`} k="now applies">
						<PathText path={path} />
					</Kv>
				))}
				{change.dropped.map(path => (
					<Kv key={`dropped:${path}`} k="no longer applies">
						<PathText path={path} />
					</Kv>
				))}
			</KvGrid>
			{moved && change.applied.length === 0 && change.dropped.length === 0 && (
				<Note>The rule files in effect are unchanged.</Note>
			)}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

export const setCwdRenderer: ToolRenderer = { Summary, Body };
