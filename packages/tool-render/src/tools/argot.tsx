/**
 * `argot_load` and `argot_unload`: arm or disarm a project's shorthand dictionary.
 *
 * Loading teaches the session a project's identifier handles so later messages
 * compress; unloading takes them away. The two numbers a reader wants are which
 * project was armed and how many handles came with it, because a load that
 * resolved to a project with a near-empty dictionary looks identical to a
 * useful one in a JSON dump and buys nothing.
 *
 * The resolved ROOT is not the path that was asked for. Argot walks from the
 * requested folder to the nearest project marker, so the two differ whenever a
 * subdirectory was named, and showing only the request would hide which project
 * actually got armed.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, num, str } from "../util";

function rootOf({ args, result }: ToolRenderProps): string | null {
	const details = detailsRecord(result);
	return (details ? str(details.root) : null) ?? str(args.folder_path);
}

/** True when the resolved root is a different path from the one requested. */
function resolvedElsewhere(root: string | null, requested: string | null): boolean {
	return root !== null && requested !== null && root !== requested;
}

function LoadSummary(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const root = rootOf(props);
	const handles = details ? num(details.handles) : null;
	return (
		<>
			<Badge tone={props.result?.isError ? "err" : "ok"}>argot load</Badge>{" "}
			{root ? <PathText path={root} /> : <span>?</span>}
			{handles !== null && <span> {handles === 1 ? "1 handle" : `${handles} handles`}</span>}
		</>
	);
}

function LoadBody(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const root = rootOf(props);
	const requested = details ? str(details.requested) : str(props.args.folder_path);
	const handles = details ? num(details.handles) : null;
	return (
		<>
			<Badges
				items={[
					<Badge key="op" tone={props.result?.isError ? "err" : "ok"}>
						loaded
					</Badge>,
					handles !== null && <span key="handles">{handles === 1 ? "1 handle" : `${handles} handles`}</span>,
				]}
			/>
			<KvGrid>
				{root && (
					<Kv k="project">
						<PathText path={root} />
					</Kv>
				)}
				{resolvedElsewhere(root, requested) && requested && (
					<Kv k="requested">
						<PathText path={requested} />
					</Kv>
				)}
			</KvGrid>
			<ResultText result={props.result} maxLines={6} />
		</>
	);
}

function UnloadSummary(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const root = rootOf(props);
	// `changed: false` means the folder was never taught, so the call did nothing.
	// That is a different outcome from an unload that dropped a live dictionary,
	// and the two are one boolean apart in the JSON.
	const changed = details?.changed === true;
	return (
		<>
			<Badge tone={props.result?.isError ? "err" : changed ? "ok" : "warn"}>
				{changed ? "argot unload" : "nothing loaded"}
			</Badge>{" "}
			{root ? <PathText path={root} /> : <span>?</span>}
		</>
	);
}

function UnloadBody(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const root = rootOf(props);
	const requested = details ? str(details.requested) : str(props.args.folder_path);
	const changed = details?.changed === true;
	return (
		<>
			<Badges
				items={[
					<Badge key="op" tone={props.result?.isError ? "err" : changed ? "ok" : "warn"}>
						{changed ? "unloaded" : "was not loaded"}
					</Badge>,
				]}
			/>
			<KvGrid>
				{root && (
					<Kv k="project">
						<PathText path={root} />
					</Kv>
				)}
				{resolvedElsewhere(root, requested) && requested && (
					<Kv k="requested">
						<PathText path={requested} />
					</Kv>
				)}
			</KvGrid>
			<ResultText result={props.result} maxLines={6} />
		</>
	);
}

export const argotLoadRenderer: ToolRenderer = { Summary: LoadSummary, Body: LoadBody };
export const argotUnloadRenderer: ToolRenderer = { Summary: UnloadSummary, Body: UnloadBody };
