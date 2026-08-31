/**
 * Milliseconds per time unit.
 *
 * This is the ONE owner for the duration constants that were previously
 * hand-defined (as `DAY_MS`, `HOUR_MS`, `WEEK_MS`, `MS_PER_DAY`) in five
 * packages. They never disagreed on value, but a redefined constant is one
 * edit away from drifting, so they all import from here now. The module has no
 * dependencies, so browser bundles reach it through `@veyyon/utils/time`.
 *
 * Each value is derived from the next smaller unit rather than written as a
 * literal, so the relationships are visible and a single edit cannot desync
 * one unit from the rest.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
