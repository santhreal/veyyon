/**
 * `manage_skill`: create, update, or delete a managed skill.
 *
 * A skill write is durable: it changes what the agent reaches for in later
 * sessions, so which of the three actions happened is the first thing a reader
 * needs, and `delete` in particular must not look like the other two.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Note, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { normalizeWs, str, truncate } from "../util";

/** Warn tone for `delete`, because removing a skill is the destructive one. */
function toneFor(action: string | null, isError: boolean | undefined): "ok" | "warn" | "err" {
	if (isError) return "err";
	return action === "delete" ? "warn" : "ok";
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const action = str(args.action);
	const name = str(args.name);
	return (
		<>
			<Badge tone={toneFor(action, result?.isError)}>{action ?? "skill"}</Badge> {name && <span>{name}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const action = str(args.action);
	const name = str(args.name);
	const description = str(args.description);
	const body = str(args.body);
	return (
		<>
			<Badges
				items={[
					<Badge key="action" tone={toneFor(action, result?.isError)}>
						{action ?? "skill"}
					</Badge>,
					name && <span key="name">{name}</span>,
				]}
			/>
			{description && <Note>{truncate(normalizeWs(description), 200)}</Note>}
			{/* `delete` carries neither description nor body, so nothing below renders
			    and the badge above is the whole story, which is correct. */}
			{body && <Output text={body} maxLines={16} lang="markdown" title="SKILL.md" />}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

export const manageSkillRenderer: ToolRenderer = { Summary, Body };
