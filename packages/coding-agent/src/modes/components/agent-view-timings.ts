/**
 * The interaction timings of the agent surfaces. Three constants that more than one file must agree on.
 * This module has no imports, so every caller pays one module.
 */

/**
 * How often a view repaints to advance its relative-time column. Five seconds: minute-granularity text
 * is at most five seconds stale, and a shorter tick would repaint for nothing.
 */
export const AGENT_VIEW_AGE_TICK_MS = 5_000;

/**
 * How long a burst of registry or bus changes is collected before one repaint. A subagent starting
 * produces several events in quick succession; 100ms is under the threshold where a user reads it as delayed.
 */
export const AGENT_VIEW_DATA_CHANGE_COALESCE_MS = 100;

/**
 * How long after a left-arrow press a second one counts as the double tap that opens the Agent Control
 * Center, or leaves a focused subagent. One window for both — same rhythm in and out.
 */
export const AGENT_VIEW_LEFT_TAP_WINDOW_MS = 500;
