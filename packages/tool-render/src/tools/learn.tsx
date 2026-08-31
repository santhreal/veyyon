/**
 * `learn`: write one durable lesson to memory, optionally creating or updating
 * a managed skill in the same call.
 *
 * The skill half is the reason this needs a renderer rather than the generic
 * dump. A `learn` call that also writes a skill changes what the agent will do
 * in future sessions, and that is a different event from noting a fact; a reader
 * scanning a transcript has to be able to tell them apart without opening JSON.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Note, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { isRecord, normalizeWs, str, truncate } from "../util";

interface SkillWrite {
	action: string | null;
	name: string | null;
	description: string | null;
	body: string | null;
}

/** The optional `skill` argument, or null when the call only records a lesson. */
function skillWrite(args: Record<string, unknown>): SkillWrite | null {
	if (!isRecord(args.skill)) return null;
	return {
		action: str(args.skill.action),
		name: str(args.skill.name),
		description: str(args.skill.description),
		body: str(args.skill.body),
	};
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const memory = str(args.memory);
	const skill = skillWrite(args);
	return (
		<>
			<Badge tone={result?.isError ? "err" : "accent"}>learn</Badge>{" "}
			{skill?.name && (
				<>
					<Badge tone="ok">
						{skill.action === "update" ? "skill updated" : "skill created"}: {skill.name}
					</Badge>{" "}
				</>
			)}
			{memory && <span className="tv-trunc">{truncate(normalizeWs(memory), 90)}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const memory = str(args.memory);
	const context = str(args.context);
	const skill = skillWrite(args);
	return (
		<>
			{memory && <Note>{memory}</Note>}
			{context && <div className="tv-faint">{context}</div>}
			{skill && (
				<>
					<Badges
						items={[
							<Badge key="action" tone="ok">
								{skill.action ?? "skill"}
							</Badge>,
							skill.name && <span key="name">{skill.name}</span>,
							skill.description && <span key="desc">{truncate(normalizeWs(skill.description), 120)}</span>,
						]}
					/>
					{/* The body is what the agent will actually read next time, so it is
					    shown rather than summarised away. */}
					{skill.body && <Output text={skill.body} maxLines={16} lang="markdown" title="SKILL.md" />}
				</>
			)}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

export const learnRenderer: ToolRenderer = { Summary, Body };
