/**
 * The interaction timings the Agent Hub and the Subagent Inbox share.
 *
 * These two views are separate components with separate render loops, and a user moves between them without
 * being told they are different screens. So a cadence that differs between them is a felt inconsistency: the
 * same relative-time column refreshing at two rates, the same double-tap gesture needing two different
 * rhythms. All three were declared in both files with the same values, and the inbox's own comment on the
 * gesture window said "matching the hub", which names the coupling without doing anything about it.
 *
 * `agent-status-display.ts` is not the home for these. Its doc makes it the owner of the AgentStatus VISUAL
 * language, colours and glyphs, and it imports the theme engine to do that; a timing constant has no business
 * dragging the theme engine along. This module has no imports, so both views pay one module.
 *
 * A per-view timing that genuinely differs stays in that view. These three are here because they are the same
 * decision, not because they happen to be equal today.
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
 * How long after a left-arrow press a second one counts as the "close this view" double tap.
 *
 * The gesture is the same in both views, so the window has to be too: a user who learns the rhythm in one
 * view uses it in the other, and a shorter window in one of them reads as the gesture not working.
 */
export const AGENT_VIEW_LEFT_TAP_WINDOW_MS = 500;
