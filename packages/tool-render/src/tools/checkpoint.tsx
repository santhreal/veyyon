/**
 * `checkpoint` and `rewind`: mark a point in the session, then roll the context
 * back to it and keep only a report.
 *
 * These share a file because they are two halves of one mechanism and a reader
 * meets them as a pair: `checkpoint` states the goal it is about to investigate,
 * `rewind` states what was learned and discards everything in between. That
 * discard is the reason they need a renderer at all. Scanning a transcript for
 * where the context was rolled back is a common thing to do, and until now both
 * fell through to the generic JSON dump, so the one line that says what survived
 * the rewind was buried in a blob.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Note, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, normalizeWs, str, truncate } from "../util";

/** The goal, from the settled result when there is one, else from the call. */
function goalOf({ args, result }: ToolRenderProps): string | null {
	const details = detailsRecord(result);
	return (details ? str(details.goal) : null) ?? str(args.goal);
}

function reportOf({ args, result }: ToolRenderProps): string | null {
	const details = detailsRecord(result);
	return (details ? str(details.report) : null) ?? str(args.report);
}

function CheckpointSummary(props: ToolRenderProps): ReactNode {
	const goal = goalOf(props);
	return (
		<>
			<Badge tone={props.result?.isError ? "err" : "ok"}>checkpoint</Badge>{" "}
			{goal ? <span>{truncate(normalizeWs(goal), 100)}</span> : <span>?</span>}
		</>
	);
}

function CheckpointBody(props: ToolRenderProps): ReactNode {
	const goal = goalOf(props);
	const details = detailsRecord(props.result);
	const startedAt = details ? str(details.startedAt) : null;
	return (
		<>
			<Badges
				items={[
					<Badge key="op" tone={props.result?.isError ? "err" : "ok"}>
						checkpoint
					</Badge>,
					startedAt && <span key="at">{startedAt}</span>,
				]}
			/>
			{goal && <Note>{goal}</Note>}
			<ResultText result={props.result} maxLines={6} />
		</>
	);
}

function RewindSummary(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	// `rewound` is only true on the success path, and a rewind that did NOT happen
	// must not read like one that did: the difference is whether the intervening
	// context still exists.
	const rewound = details?.rewound === true;
	const report = reportOf(props);
	return (
		<>
			<Badge tone={props.result?.isError ? "err" : rewound ? "ok" : "warn"}>{rewound ? "rewound" : "rewind"}</Badge>{" "}
			{report ? <span>{truncate(normalizeWs(report), 100)}</span> : <span>?</span>}
		</>
	);
}

function RewindBody(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const rewound = details?.rewound === true;
	const report = reportOf(props);
	return (
		<>
			<Badges
				items={[
					<Badge key="op" tone={props.result?.isError ? "err" : rewound ? "ok" : "warn"}>
						{rewound ? "context rewound" : "not rewound"}
					</Badge>,
				]}
			/>
			{/* The report is the ONLY thing that survives the rewind, so it is shown in
			    full rather than truncated to a line the way the summary does. */}
			{report && <Output text={report} maxLines={20} title="report" />}
			<ResultText result={props.result} maxLines={6} />
		</>
	);
}

export const checkpointRenderer: ToolRenderer = { Summary: CheckpointSummary, Body: CheckpointBody };
export const rewindRenderer: ToolRenderer = { Summary: RewindSummary, Body: RewindBody };
