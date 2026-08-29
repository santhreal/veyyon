/**
 * `vibe_spawn` / `vibe_send` / `vibe_wait` / `vibe_kill` / `vibe_list` —
 * persistent worker sessions: the mini composer (spawn/send) and the TV wall
 * (wait/list).
 *
 * Every op returns the same `details` record with a live `screens` snapshot of
 * the owner's workers, so all five share one Body and differ only in the
 * per-op line the Summary states and the outcome the Body leads with.
 *
 * Field names track the engine's `VibeToolDetails` and the five argument
 * schemas in `coding-agent/src/tools/vibe.ts`; the shapes are re-declared
 * structurally rather than imported, so this package keeps its dependency set
 * at `@veyyon/utils`, `@veyyon/wire`, `lucide-react` and `react`.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Note, Output, ResultText, Row, type Tone } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

/** One worker session as the tool snapshotted it (`VibeScreenSnapshot`). */
interface ScreenView {
	id: string;
	cli: string | null;
	state: string | null;
	model: string | null;
	turns: number | null;
	queued: number | null;
	turnMessage: string | null;
	currentTool: string | null;
	lastIntent: string | null;
	trace: string[];
	outputTail: string[];
	lastActivity: string | null;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		const text = str(entry);
		if (text !== null) out.push(text);
	}
	return out;
}

function screensOf(details: Record<string, unknown> | null): ScreenView[] {
	if (!details || !Array.isArray(details.screens)) return [];
	const out: ScreenView[] = [];
	for (const raw of details.screens) {
		if (!isRecord(raw)) continue;
		const id = str(raw.id);
		if (id === null) continue;
		out.push({
			id,
			cli: str(raw.cli),
			state: str(raw.state),
			model: str(raw.model),
			turns: num(raw.turns),
			queued: num(raw.queued),
			turnMessage: str(raw.turnMessage),
			currentTool: str(raw.currentTool),
			lastIntent: str(raw.lastIntent),
			trace: stringList(raw.trace),
			outputTail: stringList(raw.outputTail),
			lastActivity: str(raw.lastActivity),
		});
	}
	return out;
}

/**
 * `VibeSessionState` is `starting | running | idle | dead`. A worker on air and
 * a worker that died are the two a reader must not confuse, so they take the
 * two loud tones and `idle` reads as settled.
 */
function stateTone(state: string | null): Tone | undefined {
	if (state === "running" || state === "starting") return "accent";
	if (state === "dead") return "err";
	if (state === "idle") return "ok";
	return undefined;
}

/** Workers counted as on air, matching the terminal's `running || starting`. */
function onAir(screens: ScreenView[]): number {
	return screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
}

/** The sessions an op names in its arguments: `session` for send/kill, `sessions` for wait. */
function targetIds(args: Record<string, unknown>): string[] {
	const single = str(args.session);
	if (single !== null) return [single];
	return stringList(args.sessions);
}

/**
 * How `vibe_send` landed. A steered message reached a worker mid-turn; a queued
 * one did not, and drains into the next turn — the distinction decides whether
 * the sender should expect an answer to this turn.
 */
function sendModeLabel(mode: string | null): { text: string; tone: Tone } | null {
	if (mode === "turn") return { text: "turn started", tone: "ok" };
	if (mode === "steered") return { text: "steered mid-turn", tone: "accent" };
	if (mode === "queued") return { text: "queued for the next turn", tone: "warn" };
	return null;
}

/**
 * The one line that distinguishes this op. `null` when neither the arguments
 * nor the outcome carry anything yet, which is the live-streaming case.
 */
function opSummary(op: string, args: Record<string, unknown>, details: Record<string, unknown> | null): ReactNode {
	switch (op) {
		case "vibe_spawn": {
			const spawned = isRecord(details?.spawned) ? details.spawned : null;
			const cli = str(spawned?.cli) ?? str(args.cli);
			const id = str(spawned?.id) ?? str(args.name);
			const prompt = str(args.prompt);
			return (
				<>
					{cli && <Badge tone="accent">{cli}</Badge>}
					{id && <span className="tv-row-key">{id}</span>}
					{prompt && <span>{truncate(normalizeWs(prompt), 88)}</span>}
				</>
			);
		}
		case "vibe_send": {
			const send = isRecord(details?.send) ? details.send : null;
			const id = str(send?.id) ?? str(args.session);
			const mode = sendModeLabel(str(send?.mode));
			const text = str(args.message);
			return (
				<>
					{id && <span className="tv-row-key">{id}</span>}
					{mode && <Badge tone={mode.tone}>{mode.text}</Badge>}
					{text && <span>{truncate(normalizeWs(text), 88)}</span>}
				</>
			);
		}
		case "vibe_wait": {
			const wait = isRecord(details?.wait) ? details.wait : null;
			const settled = Array.isArray(wait?.settled) ? wait.settled.length : 0;
			const stillRunning = Array.isArray(wait?.stillRunning) ? wait.stillRunning.length : 0;
			const watching = targetIds(args);
			return (
				<Badges
					items={[
						wait?.waiting === true ? <Badge tone="accent">watching</Badge> : null,
						settled > 0 ? <Badge tone="ok">{`${settled} settled`}</Badge> : null,
						stillRunning > 0 ? <Badge tone="accent">{`${stillRunning} still running`}</Badge> : null,
						wait?.timedOut === true ? <Badge tone="warn">timed out</Badge> : null,
						wait === null && watching.length > 0 ? <Badge>{watching.join(", ")}</Badge> : null,
					].filter(item => item !== null)}
				/>
			);
		}
		case "vibe_kill": {
			const killed = isRecord(details?.killed) ? details.killed : null;
			const id = str(killed?.id) ?? str(args.session);
			return (
				<>
					{id && <span className="tv-row-key">{id}</span>}
					{killed?.cancelledTurn === true && <Badge tone="warn">in-flight turn cancelled</Badge>}
				</>
			);
		}
		default:
			return null;
	}
}

function VibeSummary({ name, args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const screens = screensOf(details);
	const running = onAir(screens);
	return (
		<>
			{opSummary(name, args, details)}
			{screens.length > 0 && (
				<Badge tone={running > 0 ? "accent" : undefined}>
					{running > 0
						? `${running}/${screens.length} on air`
						: `${screens.length} worker${screens.length === 1 ? "" : "s"}`}
				</Badge>
			)}
		</>
	);
}

/** One worker's card on the wall: what it is, what it is doing, what it just said. */
function Screen({ screen, settledStatus }: { screen: ScreenView; settledStatus?: string }): ReactNode {
	const activity = screen.currentTool ?? screen.lastIntent ?? screen.lastActivity;
	return (
		<div className="tv-list">
			<Row k={screen.id}>
				<Badges
					items={[
						screen.cli ? <Badge tone="accent">{screen.cli}</Badge> : null,
						screen.state ? <Badge tone={stateTone(screen.state)}>{screen.state}</Badge> : null,
						settledStatus ? (
							<Badge tone={settledStatus === "completed" ? "ok" : "err"}>{settledStatus}</Badge>
						) : null,
						screen.model ? <Badge>{screen.model}</Badge> : null,
						screen.turns !== null ? (
							<Badge>{`${screen.turns} turn${screen.turns === 1 ? "" : "s"}`}</Badge>
						) : null,
						screen.queued ? <Badge tone="warn">{`${screen.queued} queued`}</Badge> : null,
					].filter(item => item !== null)}
				/>
			</Row>
			{screen.turnMessage && <Row k="turn">{truncate(normalizeWs(screen.turnMessage), 120)}</Row>}
			{activity && <Row k="doing">{truncate(normalizeWs(activity), 120)}</Row>}
			{screen.trace.length > 0 && <Output title="trace" text={screen.trace.join("\n")} maxLines={6} />}
			{screen.outputTail.length > 0 && <Output title="output" text={screen.outputTail.join("\n")} maxLines={8} />}
		</div>
	);
}

/**
 * The settled status per session id, so a card can carry the outcome of the
 * turn the wait observed rather than only the state the worker is in now — a
 * worker that finished and started a queued follow-up reads as `running` again.
 */
function settledStatuses(details: Record<string, unknown> | null): Map<string, string> {
	const wait = isRecord(details?.wait) ? details.wait : null;
	const settled = Array.isArray(wait?.settled) ? wait.settled : [];
	const byId = new Map<string, string>();
	for (const entry of settled) {
		if (!isRecord(entry)) continue;
		const id = str(entry.id);
		const status = str(entry.status);
		if (id !== null && status !== null) byId.set(id, status);
	}
	return byId;
}

function VibeBody({ name, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const screens = screensOf(details);
	const wait = isRecord(details?.wait) ? details.wait : null;
	const statuses = settledStatuses(details);
	const stillRunning = stringList(wait?.stillRunning);

	return (
		<>
			{wait?.timedOut === true && (
				<Note tone="warn">
					{stillRunning.length > 0
						? `The wait timed out with ${stillRunning.join(", ")} still running.`
						: "The wait timed out."}
				</Note>
			)}
			{name === "vibe_list" && screens.length === 0 && <Note>No worker sessions.</Note>}
			{screens.map(screen => (
				<Screen key={screen.id} screen={screen} settledStatus={statuses.get(screen.id)} />
			))}
			{screens.length === 0 && <ResultText result={result} />}
		</>
	);
}

export const vibeRenderer: ToolRenderer = { Summary: VibeSummary, Body: VibeBody };
