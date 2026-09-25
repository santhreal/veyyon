/**
 * The plan a session is working, projected for the window.
 *
 * The board is the session's own: `AgentSession.getTodoPhases` returns what
 * the `todo` tool wrote, and every derived value here comes from the helpers
 * that tool exports. Nothing about a plan is computed twice, so the tally a
 * window states and the tally a terminal states cannot disagree, and a phase
 * is numbered by the one function that numbers phases.
 */
import { isTerminalTodoStatus } from "@veyyon/wire";
import type { AgentSession } from "../session/agent-session";
import { formatPhaseDisplayName, prioritizeTodoItems, type TodoPhase } from "../tools/agent/todo";
import type { TodoBoardView, TodoPhaseView, TodoTaskView } from "./wire";

/** The task the plan is on: the one in flight, else the first one waiting. */
function currentTask(phases: readonly TodoPhase[]): { task: TodoTaskView; phase: string } | null {
	let waiting: { task: TodoTaskView; phase: string } | null = null;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (isTerminalTodoStatus(task.status)) continue;
			const entry = { task: { content: task.content, status: task.status }, phase: phase.name };
			if (task.status === "in_progress") return entry;
			waiting ??= entry;
		}
	}
	return waiting;
}

/**
 * The board `session` holds, or null when it holds no task.
 *
 * An empty board is an absent view rather than a board of nothing: a window
 * that drew an empty plan would state a plan exists before one does.
 */
export function todoBoardView(session?: AgentSession | null): TodoBoardView | null {
	if (!session) return null;
	const phases = session.getTodoPhases().filter(phase => phase.tasks.length > 0);
	if (phases.length === 0) return null;

	const current = currentTask(phases);
	const views: TodoPhaseView[] = phases.map((phase, index) => ({
		name: formatPhaseDisplayName(phase.name, index + 1),
		tasks: prioritizeTodoItems(phase.tasks).map(task => ({ content: task.content, status: task.status })),
		closed: phase.tasks.filter(task => isTerminalTodoStatus(task.status)).length,
		active: current !== null && phase.name === current.phase,
	}));

	return {
		phases: views,
		closed: views.reduce((sum, phase) => sum + phase.closed, 0),
		total: views.reduce((sum, phase) => sum + phase.tasks.length, 0),
		current: current?.task ?? null,
	};
}

/** The Todo snapshot section for `session`. */
export function todoSection(session: AgentSession): { Todo: { session: string; board: TodoBoardView | null } } {
	return { Todo: { session: session.sessionId, board: todoBoardView(session) } };
}
