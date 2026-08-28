/** The interaction timings of the agent surfaces. These began as three constants declared twice, once in the Agent Hub overlay and once in the Subagent Inbox, */

/** How often a view repaints purely to advance its relative-time column ("3m ago"). Five seconds is chosen against what the label shows rather than against the render cost: minute-granularity */
export const AGENT_VIEW_AGE_TICK_MS = 5_000;

/** How long a burst of registry or bus changes is collected before one repaint. A subagent starting produces several events in quick succession, and repainting per event would flicker the */
export const AGENT_VIEW_DATA_CHANGE_COALESCE_MS = 100;

/** How long after a left-arrow press a second one counts as the double tap that opens the Agent Control Center, or that leaves a focused subagent for the main session. */
export const AGENT_VIEW_LEFT_TAP_WINDOW_MS = 500;
