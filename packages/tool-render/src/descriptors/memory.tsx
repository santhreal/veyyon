import { formatCount } from "@veyyon/utils/format";
import { asTodoStatus, isTodoListDone, TODO_DONE_SUMMARY, type TodoStatus } from "@veyyon/wire";
import type { ReactNode } from "react";
import {
	Badge,
	Badges,
	CodeBlock,
	DiffBlock,
	InvalidArg,
	Kv,
	KvGrid,
	Note,
	Output,
	PathText,
	ResultImages,
	ResultText,
	Row,
	type Tone,
} from "../parts";
import type { ToolDescriptor, ToolRenderProps, ToolResultBlock, ToolResultLike } from "../types";
import {
	detailsRecord,
	finiteNumber,
	isRecord,
	keyed,
	languageFromPath,
	normalizeWs,
	replaceTabs,
	resultImagesOf,
	resultTextOf,
	shortenPath,
	str,
	strList,
	truncate,
} from "../util";

// ============================================================================
// learn
// ============================================================================

interface SkillWrite {
	action: string | null;
	name: string | null;
	description: string | null;
	body: string | null;
}

function skillWrite(args: Record<string, unknown>): SkillWrite | null {
	if (!isRecord(args.skill)) return null;
	return {
		action: str(args.skill.action),
		name: str(args.skill.name),
		description: str(args.skill.description),
		body: str(args.skill.body),
	};
}

function LearnSummary({ args, result }: ToolRenderProps): ReactNode {
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

function LearnBody({ args, result }: ToolRenderProps): ReactNode {
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
					{skill.body && <Output text={skill.body} maxLines={16} lang="markdown" title="SKILL.md" />}
				</>
			)}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

// ============================================================================
// manage_skill
// ============================================================================

function manageSkillTone(action: string | null, isError: boolean | undefined): Tone | undefined {
	if (isError) return "err";
	return action === "delete" ? "warn" : "ok";
}

function ManageSkillSummary({ args, result }: ToolRenderProps): ReactNode {
	const action = str(args.action);
	const name = str(args.name);
	return (
		<>
			<Badge tone={manageSkillTone(action, result?.isError)}>{action ?? "skill"}</Badge>{" "}
			{name && <span>{name}</span>}
		</>
	);
}

function ManageSkillBody({ args, result }: ToolRenderProps): ReactNode {
	const action = str(args.action);
	const name = str(args.name);
	const description = str(args.description);
	const body = str(args.body);
	return (
		<>
			<Badges
				items={[
					<Badge key="action" tone={manageSkillTone(action, result?.isError)}>
						{action ?? "skill"}
					</Badge>,
					name && <span key="name">{name}</span>,
				]}
			/>
			{description && <Note>{truncate(normalizeWs(description), 200)}</Note>}
			{body && <Output text={body} maxLines={16} lang="markdown" title="SKILL.md" />}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

// ============================================================================
// memory_edit
// ============================================================================

function memoryEditTone(op: string | null, isError: boolean | undefined): Tone | undefined {
	if (isError) return "err";
	return op === "forget" ? "warn" : "ok";
}

function MemoryEditSummary({ args, result }: ToolRenderProps): ReactNode {
	const op = str(args.op);
	const id = str(args.id);
	const replacement = str(args.replacement_id);
	return (
		<>
			<Badge tone={memoryEditTone(op, result?.isError)}>{op ?? "memory"}</Badge> {id && <span>{id}</span>}
			{replacement && <span> → {replacement}</span>}
		</>
	);
}

function MemoryEditBody({ args, result }: ToolRenderProps): ReactNode {
	const op = str(args.op);
	const id = str(args.id);
	const content = str(args.content);
	const importance = finiteNumber(args.importance);
	const replacement = str(args.replacement_id);
	return (
		<>
			<Badges
				items={[
					<Badge key="op" tone={memoryEditTone(op, result?.isError)}>
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

// ============================================================================
// recall (alias: memory_recall)
// ============================================================================

interface RecallEntry {
	text: string;
	type: string | null;
	date: string | null;
}

function recallFoundCount(props: ToolRenderProps): number | null {
	const { result } = props;
	if (!result || result.isError) return null;
	const match = resultTextOf(result).match(/^Found (\d+) relevant/);
	return match ? Number(match[1]) : 0;
}

function parseRecallEntry(raw: string): RecallEntry {
	let text = raw.replace(/^-\s+/, "").trim();
	let date: string | null = null;
	let type: string | null = null;
	const dateMatch = text.match(/\s\(([^()]+)\)$/);
	if (dateMatch) {
		date = dateMatch[1] ?? null;
		text = text.slice(0, -dateMatch[0].length);
	}
	const typeMatch = text.match(/\s\[([^[\]]+)\]$/);
	if (typeMatch) {
		type = typeMatch[1] ?? null;
		text = text.slice(0, -typeMatch[0].length);
	}
	return { text, type, date };
}

function RecallSummary(props: ToolRenderProps): ReactNode {
	const query = str(props.args.query);
	const found = recallFoundCount(props);
	return (
		<>
			{query !== null ? <span>{truncate(normalizeWs(query), 96)}</span> : <InvalidArg what="query" />}
			{found !== null && (
				<> {found > 0 ? <Badge tone="accent">{found} found</Badge> : <Badge tone="warn">no matches</Badge>}</>
			)}
		</>
	);
}

function RecallBody(props: ToolRenderProps): ReactNode {
	const { args, result } = props;
	const query = str(args.query) ?? "";
	const text = resultTextOf(result);
	const found = recallFoundCount(props);
	let asOf: string | null = null;
	let entries: RecallEntry[] = [];
	if (found !== null && found > 0) {
		asOf = text.match(/\(as of ([^()]+) UTC\)/)?.[1] ?? null;
		entries = text
			.replace(/^[^\n]*\n+/, "")
			.split(/\n{2,}/)
			.map(parseRecallEntry)
			.filter(entry => entry.text.length > 0);
	}
	return (
		<>
			{query && <Output text={query} title="query" maxLines={4} />}
			{entries.length > 0 ? (
				<>
					{asOf && <Badges items={[`as of ${asOf} UTC`]} />}
					<div className="tv-list">
						{keyed(entries, entry => entry.text).map(({ key, item: entry }) => (
							<Row key={key}>
								<span>{entry.text}</span>
								{(entry.type !== null || entry.date !== null) && <Badges items={[entry.type, entry.date]} />}
							</Row>
						))}
					</div>
				</>
			) : (
				<ResultText result={result} maxLines={12} />
			)}
		</>
	);
}

// ============================================================================
// reflect (alias: memory_reflect)
// ============================================================================

function ReflectSummary({ args }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	return <span>{query ? truncate(normalizeWs(query), 96) : ""}</span>;
}

function ReflectBody({ args, result }: ToolRenderProps): ReactNode {
	const query = str(args.query) ?? "";
	const context = str(args.context) ?? "";
	const failedSilently = result?.isError === true && !resultTextOf(result);
	return (
		<>
			{query && <Output text={query} title="query" maxLines={4} />}
			{context && <Output text={context} title="context" maxLines={6} />}
			{failedSilently ? <Note tone="err">Reflect failed</Note> : <ResultText result={result} maxLines={12} />}
		</>
	);
}

// ============================================================================
// retain (alias: memory_retain)
// ============================================================================

interface RetainItem {
	content: string;
	context: string | null;
}

function retainItems(args: Record<string, unknown>): RetainItem[] | null {
	const raw = args.items;
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	const items: RetainItem[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const content = replaceTabs((str(entry.content) ?? "").trim());
		if (!content) continue;
		items.push({ content, context: str(entry.context) });
	}
	return items;
}

function RetainSummary({ args, result }: ToolRenderProps): ReactNode {
	const items = retainItems(args);
	if (items === null) return <InvalidArg what="items" />;
	const count = finiteNumber(detailsRecord(result)?.count) ?? items.length;
	const first = items[0] ? truncate(normalizeWs(items[0].content), 80) : "";
	return (
		<>
			<Badge tone="accent">{count === 1 ? "1 memory" : `${count} memories`}</Badge>
			{first && <span className="tv-trunc">{first}</span>}
		</>
	);
}

function RetainBody({ args, result }: ToolRenderProps): ReactNode {
	const items = retainItems(args);
	const count = finiteNumber(detailsRecord(result)?.count);
	let confirmation: string | null = null;
	if (result && result.isError !== true) {
		const text = resultTextOf(result).trim().replace(/\.$/, "");
		confirmation = text || (count !== null ? `${count === 1 ? "1 memory" : `${count} memories`} retained` : null);
	}
	return (
		<>
			{items === null ? (
				<InvalidArg what="items" />
			) : (
				items.length > 0 && (
					<div className="tv-list">
						{keyed(items, item => item.content).map(({ key, item }) => (
							<Row key={key}>
								{item.content}
								{item.context && <span className="tv-faint"> — {item.context}</span>}
							</Row>
						))}
					</div>
				)
			)}
			{confirmation ? (
				<div>
					<Badge tone="ok">{confirmation}</Badge>
				</div>
			) : (
				<ResultText result={result} maxLines={6} />
			)}
		</>
	);
}

// ============================================================================
// checkpoint & rewind
// ============================================================================

function checkpointGoalOf({ args, result }: ToolRenderProps): string | null {
	const details = detailsRecord(result);
	return (details ? str(details.goal) : null) ?? str(args.goal);
}

function rewindReportOf({ args, result }: ToolRenderProps): string | null {
	const details = detailsRecord(result);
	return (details ? str(details.report) : null) ?? str(args.report);
}

function CheckpointSummary(props: ToolRenderProps): ReactNode {
	const goal = checkpointGoalOf(props);
	return (
		<>
			<Badge tone={props.result?.isError ? "err" : "ok"}>checkpoint</Badge>{" "}
			{goal ? <span>{truncate(normalizeWs(goal), 100)}</span> : <span>?</span>}
		</>
	);
}

function CheckpointBody(props: ToolRenderProps): ReactNode {
	const goal = checkpointGoalOf(props);
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
	const rewound = details?.rewound === true;
	const report = rewindReportOf(props);
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
	const report = rewindReportOf(props);
	return (
		<>
			<Badges
				items={[
					<Badge key="op" tone={props.result?.isError ? "err" : rewound ? "ok" : "warn"}>
						{rewound ? "context rewound" : "not rewound"}
					</Badge>,
				]}
			/>
			{report && <Output text={report} maxLines={20} title="report" />}
			<ResultText result={props.result} maxLines={6} />
		</>
	);
}

// ============================================================================
// argot_load & argot_unload
// ============================================================================

function argotRootOf({ args, result }: ToolRenderProps): string | null {
	const details = detailsRecord(result);
	return (details ? str(details.root) : null) ?? str(args.folder_path);
}

function resolvedElsewhere(root: string | null, requested: string | null): boolean {
	return root !== null && requested !== null && root !== requested;
}

function ArgotLoadSummary(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const root = argotRootOf(props);
	const handles = details ? finiteNumber(details.handles) : null;
	return (
		<>
			<Badge tone={props.result?.isError ? "err" : "ok"}>argot load</Badge>{" "}
			{root ? <PathText path={root} /> : <span>?</span>}
			{handles !== null && <span> {handles === 1 ? "1 handle" : `${handles} handles`}</span>}
		</>
	);
}

function renderArgotBody(props: ToolRenderProps, badges: ReactNode[]): ReactNode {
	const details = detailsRecord(props.result);
	const root = argotRootOf(props);
	const requested = details ? str(details.requested) : str(props.args.folder_path);
	return (
		<>
			<Badges items={badges} />
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

function ArgotLoadBody(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const handles = details ? finiteNumber(details.handles) : null;
	return renderArgotBody(props, [
		<Badge key="op" tone={props.result?.isError ? "err" : "ok"}>
			loaded
		</Badge>,
		handles !== null && <span key="handles">{handles === 1 ? "1 handle" : `${handles} handles`}</span>,
	]);
}

function ArgotUnloadSummary(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const root = argotRootOf(props);
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

function ArgotUnloadBody(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const changed = details?.changed === true;
	return renderArgotBody(props, [
		<Badge key="op" tone={props.result?.isError ? "err" : changed ? "ok" : "warn"}>
			{changed ? "unloaded" : "was not loaded"}
		</Badge>,
	]);
}

// ============================================================================
// report_finding & report_tool_issue
// ============================================================================

function priorityTone(priority: string): Tone | undefined {
	switch (priority) {
		case "P0":
			return "err";
		case "P1":
			return "warn";
		case "P3":
			return "accent";
		default:
			return undefined;
	}
}

function ReportFindingSummary({ args }: ToolRenderProps): ReactNode {
	const priority = str(args.priority);
	const title = str(args.title);
	return (
		<>
			{priority && <Badge tone={priorityTone(priority)}>{priority}</Badge>}
			{title && <span> {truncate(title.replace(/^\[P\d\]\s*/, ""), 80)}</span>}
		</>
	);
}

function ReportFindingBody({ args, result }: ToolRenderProps): ReactNode {
	const priority = str(args.priority);
	const confidence = finiteNumber(args.confidence);
	const filePath = str(args.file_path);
	const lineStart = finiteNumber(args.line_start);
	const lineEnd = finiteNumber(args.line_end);
	const body = str(args.body);
	return (
		<>
			<Badges
				items={[
					priority && <Badge tone={priorityTone(priority)}>{priority}</Badge>,
					confidence !== null && <Badge>confidence {(confidence * 100).toFixed(0)}%</Badge>,
					filePath && <PathText path={filePath} from={lineStart ?? undefined} to={lineEnd ?? undefined} />,
				]}
			/>
			{body && <Output text={body} maxLines={12} />}
			{result?.isError && <ResultText result={result} maxLines={6} />}
		</>
	);
}

function ReportToolIssueSummary({ args }: ToolRenderProps): ReactNode {
	const tool = str(args.tool);
	const report = str(args.report);
	if (!tool && !report) return <InvalidArg what="report" />;
	return (
		<span>
			{tool && <Badge tone="warn">{tool}</Badge>}
			{report && <span> {truncate(normalizeWs(report), 80)}</span>}
		</span>
	);
}

function ReportToolIssueBody({ args, result }: ToolRenderProps): ReactNode {
	const report = str(args.report);
	return (
		<>
			{report && <Note tone="warn">{report}</Note>}
			<ResultText result={result} maxLines={4} />
		</>
	);
}

// ============================================================================
// resolve
// ============================================================================

function ResolveSummary({ args, result }: ToolRenderProps): ReactNode {
	const action = str(args.action);
	const reason = str(args.reason);
	const tone = result?.isError ? "err" : action === "apply" ? "ok" : "warn";
	return (
		<>
			<Badge tone={tone}>{action ?? "?"}</Badge> {reason && <span>{truncate(normalizeWs(reason), 100)}</span>}
		</>
	);
}

function ResolveBody({ args, result }: ToolRenderProps): ReactNode {
	const action = str(args.action);
	const reason = str(args.reason);
	const tone = result?.isError ? "err" : action === "apply" ? "ok" : "warn";
	const details = detailsRecord(result);
	const sourceToolName = details ? str(details.sourceToolName) : null;
	const label = details ? str(details.label) : null;
	const extra = isRecord(args.extra) ? args.extra : details && isRecord(details.extra) ? details.extra : null;
	const extraRows: ReactNode[] = [];
	if (extra) {
		for (const k in extra) {
			const v = extra[k];
			let text: string;
			if (typeof v === "string") text = v;
			else {
				try {
					text = JSON.stringify(v) ?? String(v);
				} catch {
					text = String(v);
				}
			}
			extraRows.push(
				<Kv key={k} k={k}>
					{truncate(normalizeWs(text), 200)}
				</Kv>,
			);
		}
	}
	return (
		<>
			<Badges
				items={[
					<Badge key="action" tone={tone}>
						{action === "apply"
							? "proposed → resolved"
							: action === "discard"
								? "proposed → rejected"
								: (action ?? "?")}
					</Badge>,
					sourceToolName && <Badge key="source">{sourceToolName}</Badge>,
					label && <span key="label">{truncate(normalizeWs(label), 120)}</span>,
				]}
			/>
			{reason && <Note>{reason}</Note>}
			{extraRows.length > 0 && <KvGrid>{extraRows}</KvGrid>}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

// ============================================================================
// todo
// ============================================================================

const TASK_ICONS: Record<TodoStatus, string> = {
	completed: "✓",
	in_progress: "→",
	abandoned: "✕",
	pending: "○",
};

const ROMAN_PAIRS: ReadonlyArray<readonly [number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

function roman(n: number): string {
	if (n <= 0) return "";
	let out = "";
	let rem = n;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

function toOps(args: ToolRenderProps["args"]): unknown[] {
	if (Array.isArray(args.ops)) return args.ops;
	return typeof args.op === "string" ? [args] : [];
}

function TodoSummary({ args }: ToolRenderProps): ReactNode {
	const ops = toOps(args);
	const counts: Record<string, number> = {};
	const order: string[] = [];
	let firstTask: string | null = null;
	for (const entry of ops) {
		if (!isRecord(entry)) continue;
		const op = str(entry.op) ?? "update";
		if (counts[op] === undefined) {
			counts[op] = 0;
			order.push(op);
		}
		counts[op]++;
		if (firstTask === null) {
			firstTask = str(entry.task) ?? str(entry.phase);
			if (firstTask === null && Array.isArray(entry.list)) {
				const head = entry.list.find(isRecord);
				if (head && Array.isArray(head.items)) firstTask = str(head.items[0]);
			}
		}
	}
	const labels = order.map(op => (counts[op] > 1 ? `${op}×${counts[op]}` : op));
	return (
		<>
			<Badges items={labels.length > 0 ? labels : ["update"]} />
			{firstTask !== null && <span> {truncate(normalizeWs(firstTask), 60)}</span>}
		</>
	);
}

function opRow(entry: unknown, key: number): ReactNode {
	if (!isRecord(entry)) return null;
	const parts: string[] = [];
	const task = str(entry.task);
	const phase = str(entry.phase);
	if (task !== null) parts.push(task);
	if (phase !== null) parts.push(phase);
	if (Array.isArray(entry.items) && entry.items.length > 0) {
		parts.push(formatCount("item", entry.items.length));
	}
	if (Array.isArray(entry.list) && entry.list.length > 0) {
		let tasks = 0;
		for (const phaseEntry of entry.list) {
			if (isRecord(phaseEntry) && Array.isArray(phaseEntry.items)) tasks += phaseEntry.items.length;
		}
		parts.push(`${formatCount("phase", entry.list.length)} · ${tasks} tasks`);
	}
	return (
		<Row key={key} k={str(entry.op) ?? "update"}>
			{truncate(normalizeWs(parts.join(" · ")), 160)}
		</Row>
	);
}

function TodoBoard({ phases }: { phases: unknown[] }): ReactNode {
	const board: Array<{ name: string; tasks: Array<{ status: TodoStatus; content: string }> }> = [];
	for (const phase of phases) {
		if (!isRecord(phase)) continue;
		const tasks: Array<{ status: TodoStatus; content: string }> = [];
		if (Array.isArray(phase.tasks)) {
			for (const task of phase.tasks) {
				if (!isRecord(task)) continue;
				tasks.push({ status: asTodoStatus(task.status), content: str(task.content) ?? "" });
			}
		}
		board.push({ name: str(phase.name) ?? "", tasks });
	}
	if (board.length === 0) return null;
	if (isTodoListDone(board)) {
		let done = 0;
		for (const phase of board) done += phase.tasks.length;
		const summary = `${TASK_ICONS.completed} ${TODO_DONE_SUMMARY} · ${formatCount("task", done)}`;
		return (
			<div className="tv-todo">
				<div className="tv-todo-done">{summary}</div>
			</div>
		);
	}
	const rendered: ReactNode[] = [];
	for (let i = 0; i < board.length; i++) {
		const phase = board[i];
		rendered.push(
			<div key={`p${i}`} className="tv-todo-phase">
				{roman(i + 1)}. {phase.name}
			</div>,
		);
		for (let t = 0; t < phase.tasks.length; t++) {
			const task = phase.tasks[t];
			rendered.push(
				<div key={`p${i}t${t}`} className={`tv-task tv-task--${task.status}`}>
					<span className="tv-task-icon">{TASK_ICONS[task.status]}</span>
					<span>{task.content}</span>
				</div>,
			);
		}
	}
	return <div className="tv-todo">{rendered}</div>;
}

function TodoBody({ args, result }: ToolRenderProps): ReactNode {
	const ops = toOps(args);
	const rec = detailsRecord(result);
	const phases = rec && Array.isArray(rec.phases) && !result?.isError ? rec.phases : null;
	return (
		<>
			{ops.length > 0 && <div className="tv-list">{ops.map(opRow)}</div>}
			{phases !== null ? <TodoBoard phases={phases} /> : <ResultText result={result} maxLines={8} />}
		</>
	);
}

// ============================================================================
// inspect_image & generate_image
// ============================================================================

function withDetailImages(result: ToolResultLike | undefined): ToolResultLike | undefined {
	const details = detailsRecord(result);
	if (!result || !details || !Array.isArray(details.images)) return result;
	const extra: ToolResultBlock[] = [];
	for (const img of details.images) {
		if (isRecord(img) && typeof img.data === "string" && typeof img.mimeType === "string") {
			extra.push({ type: "image", data: img.data, mimeType: img.mimeType });
		}
	}
	if (extra.length === 0) return result;
	return { content: result.content.concat(extra), details: result.details, isError: result.isError };
}

function GenerateImageSummary({ args }: ToolRenderProps): ReactNode {
	const subject = str(args.subject);
	const aspect = str(args.aspect_ratio);
	const changes = Array.isArray(args.changes) ? args.changes.length : 0;
	return (
		<>
			{subject ? (
				<span>{truncate(normalizeWs(subject), 80)}</span>
			) : (
				args.subject !== undefined && <InvalidArg what="subject" />
			)}{" "}
			{aspect && <Badge>{aspect}</Badge>}
			{changes > 0 && <Badge tone="accent">edit ×{changes}</Badge>}
		</>
	);
}

const PROMPT_FIELDS = [
	["subject", "subject"],
	["action", "action"],
	["scene", "scene"],
	["composition", "composition"],
	["lighting", "lighting"],
	["style", "style"],
	["text", "text"],
	["aspect_ratio", "aspect"],
	["image_size", "size"],
] as const;

function GenerateImageBody({ args, result }: ToolRenderProps): ReactNode {
	const changes = Array.isArray(args.changes) ? args.changes : null;
	const inputs = Array.isArray(args.input) ? args.input : null;
	const details = detailsRecord(result);
	const provider = str(details?.provider);
	const model = str(details?.model);
	const revised = str(details?.revisedPrompt);
	const paths: string[] = [];
	if (details && Array.isArray(details.imagePaths)) {
		for (const p of details.imagePaths) {
			if (typeof p === "string") paths.push(p);
		}
	}
	const merged = withDetailImages(result);
	const hasImages = resultImagesOf(merged).length > 0;
	return (
		<>
			<KvGrid>
				{PROMPT_FIELDS.map(([arg, label]) => {
					const value = args[arg];
					return (
						<Kv key={arg} k={label}>
							{value === undefined ? null : (str(value) ?? <InvalidArg what={label} />)}
						</Kv>
					);
				})}
			</KvGrid>
			{changes && changes.length > 0 && (
				<div className="tv-list">
					{keyed(changes, change => (typeof change === "string" ? change : "")).map(({ key, item: change }, i) => (
						<Row key={key} k={i === 0 ? "changes" : undefined}>
							{typeof change === "string" ? change : <InvalidArg what="change" />}
						</Row>
					))}
				</div>
			)}
			{inputs && inputs.length > 0 && (
				<div className="tv-list">
					{keyed(inputs, input => (isRecord(input) ? (str(input.path) ?? str(input.mime_type) ?? "") : "")).map(
						({ key, item: input }, i) => {
							const path = isRecord(input) ? str(input.path) : null;
							const mime = isRecord(input) ? str(input.mime_type) : null;
							return (
								<Row key={key} k={i === 0 ? "input" : undefined}>
									{!isRecord(input) ? (
										<InvalidArg what="input" />
									) : path ? (
										<PathText path={path} />
									) : (
										`base64 image${mime ? ` (${mime})` : ""}`
									)}
								</Row>
							);
						},
					)}
				</div>
			)}
			{(provider || model) && <Badges items={[provider, model]} />}
			{revised && <Note>revised: {truncate(revised, 400)}</Note>}
			<ResultImages result={merged} />
			{paths.length > 0 && (
				<div className="tv-list">
					{keyed(paths, p => p).map(({ key, item: p }, i) => (
						<Row key={key} k={i === 0 ? "saved" : undefined}>
							<PathText path={p} />
						</Row>
					))}
				</div>
			)}
			{!hasImages && <ResultText result={result} maxLines={8} />}
		</>
	);
}

function InspectImageSummary({ args, result }: ToolRenderProps): ReactNode {
	const rec = detailsRecord(result);
	const target = str(args.path) ?? str(args.url) ?? (rec ? str(rec.imagePath) : null);
	if (target === null) return <InvalidArg what="image path" />;
	return <span>{truncate(shortenPath(target))}</span>;
}

function InspectImageBody({ args, result }: ToolRenderProps): ReactNode {
	const rec = detailsRecord(result);
	const model = rec ? str(rec.model) : null;
	const mimeType = rec ? str(rec.mimeType) : null;
	const target = str(args.path) ?? str(args.url) ?? (rec ? str(rec.imagePath) : null);
	const question = str(args.question)?.trim() ?? "";
	return (
		<>
			<KvGrid>
				{target !== null ? (
					<Kv k="target">
						<PathText path={target} />
					</Kv>
				) : (
					<InvalidArg what="image path" />
				)}
				{model && <Kv k="model">{model}</Kv>}
				{mimeType && <Kv k="type">{mimeType}</Kv>}
				{question && <Kv k="question">{question}</Kv>}
			</KvGrid>
			<ResultImages result={result} />
			<ResultText result={result} maxLines={10} />
		</>
	);
}

// ============================================================================
// ast_edit
// ============================================================================

interface AstEditOp {
	pat: string;
	out: string;
}

interface AstEditDetails {
	totalReplacements: number | null;
	filesTouched: number | null;
	filesSearched: number | null;
	limitReached: boolean;
	scopePath: string | null;
	fileReplacements: Array<{ path: string; count: number | null }>;
	parseErrors: string[];
	parseErrorsTotal: number | null;
	displayContent: string | null;
}

function pathsOf(args: Record<string, unknown>): string[] {
	return strList(args.paths);
}

function opsOf(args: Record<string, unknown>): AstEditOp[] {
	if (!Array.isArray(args.ops)) return [];
	const ops: AstEditOp[] = [];
	for (const op of args.ops) {
		if (!isRecord(op)) continue;
		ops.push({ pat: str(op.pat) ?? "", out: str(op.out) ?? "" });
	}
	return ops;
}

function astEditDetailsOf(result: ToolRenderProps["result"]): AstEditDetails | null {
	const d = detailsRecord(result);
	if (!d) return null;
	const fileReplacements: AstEditDetails["fileReplacements"] = [];
	if (Array.isArray(d.fileReplacements)) {
		for (const fr of d.fileReplacements) {
			if (!isRecord(fr)) continue;
			const path = str(fr.path);
			if (path) fileReplacements.push({ path, count: finiteNumber(fr.count) });
		}
	}
	const parseErrors = strList(d.parseErrors);
	return {
		totalReplacements: finiteNumber(d.totalReplacements),
		filesTouched: finiteNumber(d.filesTouched),
		filesSearched: finiteNumber(d.filesSearched),
		limitReached: d.limitReached === true,
		scopePath: str(d.scopePath),
		fileReplacements,
		parseErrors,
		parseErrorsTotal: finiteNumber(d.parseErrorsTotal),
		displayContent: str(d.displayContent),
	};
}

function AstEditSummary({ args, result }: ToolRenderProps): ReactNode {
	const paths = pathsOf(args);
	const first = paths[0];
	const opCount = Array.isArray(args.ops) ? args.ops.length : 0;
	const details = astEditDetailsOf(result);
	const total = details?.totalReplacements;
	return (
		<>
			{first ? <PathText path={first} /> : <InvalidArg what="paths" />}
			{paths.length > 1 && <span className="tv-faint">+{paths.length - 1} more</span>}
			<Badge tone="accent">{formatCount("op", opCount)}</Badge>
			{total != null && <Badge tone={total > 0 ? "ok" : "warn"}>{formatCount("replacement", total)}</Badge>}
			{details?.limitReached && <Badge tone="warn">limit</Badge>}
		</>
	);
}

function OpCell({ op, lang }: { op: AstEditOp; lang: string | null }): ReactNode {
	return (
		<div className="tv-cell">
			{op.pat ? (
				<CodeBlock code={op.pat} lang={lang} title="pattern" maxLines={10} />
			) : (
				<InvalidArg what="pattern" />
			)}
			{op.out ? (
				<CodeBlock code={op.out} lang={lang} title="replacement" maxLines={10} />
			) : (
				<div className="tv-muted">deletion — matched code is removed</div>
			)}
		</div>
	);
}

function AstEditBody({ args, result }: ToolRenderProps): ReactNode {
	const paths = pathsOf(args);
	const first = paths[0];
	const ops = opsOf(args);
	const details = result?.isError ? null : astEditDetailsOf(result);
	const lang = first ? languageFromPath(first) : null;
	const parseErrorsTotal = details ? (details.parseErrorsTotal ?? details.parseErrors.length) : 0;
	return (
		<>
			{paths.length > 1 && (
				<div className="tv-list">
					{keyed(paths, p => p).map(({ key, item: p }) => (
						<Row key={key}>
							<PathText path={p} />
						</Row>
					))}
				</div>
			)}
			{ops.length > 0 && (
				<div className="tv-cells">
					{keyed(ops, op => `${op.pat}\u001f${op.out}`).map(({ key, item: op }) => (
						<OpCell key={key} op={op} lang={lang} />
					))}
				</div>
			)}
			{details && (
				<span className="tv-badges">
					{details.totalReplacements != null && (
						<Badge tone={details.totalReplacements > 0 ? "ok" : "warn"}>
							{formatCount("replacement", details.totalReplacements)}
						</Badge>
					)}
					{details.filesTouched != null && <Badge>{formatCount("file", details.filesTouched)}</Badge>}
					{details.filesSearched != null && <Badge>searched {details.filesSearched}</Badge>}
					{details.scopePath && <Badge>in {shortenPath(details.scopePath)}</Badge>}
					{details.limitReached && <Badge tone="warn">limit reached</Badge>}
				</span>
			)}
			{details && details.fileReplacements.length > 0 && (
				<div className="tv-list">
					{keyed(details.fileReplacements, fr => fr.path).map(({ key, item: fr }) => (
						<Row key={key} k={fr.count != null ? `×${fr.count}` : undefined}>
							<PathText path={fr.path} />
						</Row>
					))}
				</div>
			)}
			{details?.limitReached && <Note tone="warn">limit reached; narrow path</Note>}
			{details && details.parseErrors.length > 0 && (
				<Output
					text={details.parseErrors.join("\n")}
					maxLines={6}
					title={`parse issues (${parseErrorsTotal})`}
					variant="plain"
				/>
			)}
			{details?.displayContent ? (
				<DiffBlock diff={details.displayContent} maxLines={40} />
			) : (
				<ResultText result={result} maxLines={12} />
			)}
		</>
	);
}

// ============================================================================
// Exports
// ============================================================================

export const memoryDescriptors: readonly ToolDescriptor[] = [
	{ name: "learn", Summary: LearnSummary, Body: LearnBody },
	{ name: "manage_skill", Summary: ManageSkillSummary, Body: ManageSkillBody },
	{ name: "memory_edit", Summary: MemoryEditSummary, Body: MemoryEditBody },
	{ name: "recall", aliases: ["memory_recall"], Summary: RecallSummary, Body: RecallBody },
	{ name: "reflect", aliases: ["memory_reflect"], Summary: ReflectSummary, Body: ReflectBody },
	{ name: "retain", aliases: ["memory_retain"], Summary: RetainSummary, Body: RetainBody },
	{ name: "checkpoint", Summary: CheckpointSummary, Body: CheckpointBody },
	{ name: "rewind", Summary: RewindSummary, Body: RewindBody },
	{ name: "argot_load", Summary: ArgotLoadSummary, Body: ArgotLoadBody },
	{ name: "argot_unload", Summary: ArgotUnloadSummary, Body: ArgotUnloadBody },
	{ name: "report_finding", Summary: ReportFindingSummary, Body: ReportFindingBody },
	{ name: "report_tool_issue", Summary: ReportToolIssueSummary, Body: ReportToolIssueBody },
	{ name: "resolve", Summary: ResolveSummary, Body: ResolveBody },
	{ name: "todo", Summary: TodoSummary, Body: TodoBody },
	{ name: "inspect_image", Summary: InspectImageSummary, Body: InspectImageBody },
	{ name: "generate_image", Summary: GenerateImageSummary, Body: GenerateImageBody },
	{ name: "ast_edit", Summary: AstEditSummary, Body: AstEditBody },
];
