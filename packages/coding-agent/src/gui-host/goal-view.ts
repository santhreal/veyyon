import type { GoalDriver } from "../goals/driver";
import type { AgentSession } from "../session/agent-session";
import type { GoalStatus, GoalView } from "./wire";

/**
 * Project a session's current goal mode state and goal record into the wire GoalView.
 * Returns null when the session holds no goal.
 */
export function goalView(
	session?: AgentSession | null,
	driver?: GoalDriver | null,
	stoodDown?: string | null,
): GoalView | null {
	if (!session) return null;
	const state = session.getGoalModeState();
	const goal = state?.goal;
	if (!goal) return null;

	const driving = driver?.enabled === true;
	const status: GoalStatus = goal.status === "budget-limited" ? "budget_limited" : goal.status;

	return {
		objective: goal.objective,
		status,
		driving,
		tokens_used: goal.tokensUsed,
		token_budget: goal.tokenBudget ?? null,
		turns_completed: goal.turnsCompleted,
		time_used_seconds: goal.timeUsedSeconds,
		created_at_ms: goal.createdAt,
		updated_at_ms: goal.updatedAt,
		stood_down: driving ? null : (stoodDown ?? null),
	};
}

/**
 * Construct the Goal snapshot section payload for this session.
 */
export function goalSection(
	session: AgentSession,
	driver?: GoalDriver | null,
	stoodDown?: string | null,
): { Goal: { session: string; goal: GoalView | null } } {
	return {
		Goal: {
			session: session.sessionId,
			goal: goalView(session, driver, stoodDown),
		},
	};
}
