/**
 * The interaction timings of the agent surfaces.
 *
 * These began as three constants declared twice, once in the Agent Hub overlay and once in the Subagent Inbox,
 * with the inbox's own comment on the gesture window reading "matching the hub", which names the coupling
 * without doing anything about it. Both views are gone: the Agent Control Center replaced them. The module
 * stays because the coupling did. The card owns two of the numbers and the input controller owns the third, so
 * the same three values still span more than one file, and a card whose age column advanced at one rate while
 * the gesture that opens it used a different rhythm would be the same felt inconsistency one level over.
 *
 * `agent-status-display.ts` is not the home for these. Its doc makes it the owner of the AgentStatus VISUAL
 * language, colours and glyphs, and it imports the theme engine to do that; a timing constant has no business
 * dragging the theme engine along. This module has no imports, so every caller pays one module.
 *
 * A timing that genuinely belongs to one surface stays in that surface. These three are here because more than
 * one file has to agree on them, not because they happen to be equal today.
 */

/**
 * How often a view repaints purely to advance its relative-time column ("3m ago").
 *
 * Five seconds is chosen against what the label shows rather than against the render cost: minute-granularity
 * text is at most five seconds stale, which no one notices, and a shorter tick would repaint for nothing.
 */
export const AGENT_VIEW_AGE_TICK_MS = 5_000;

/**
 * How long a burst of registry or bus changes is collected before one repaint.
 *
 * A subagent starting produces several events in quick succession, and repainting per event would flicker the
 * table. A hundred milliseconds is under the threshold where a user reads the update as delayed.
 */
export const AGENT_VIEW_DATA_CHANGE_COALESCE_MS = 100;

/**
 * How long after a left-arrow press a second one counts as the double tap that opens the Agent Control Center,
 * or that leaves a focused subagent for the main session.
 *
 * One window for both, because a user who learns the rhythm going in uses the same rhythm coming out, and a
 * shorter window on one end reads as the gesture not working rather than as two separate gestures.
 */
export const AGENT_VIEW_LEFT_TAP_WINDOW_MS = 500;
