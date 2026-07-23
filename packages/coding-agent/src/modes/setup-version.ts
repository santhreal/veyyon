/**
 * Onboarding "generation" gate.
 *
 * Onboarding runs on the FIRST install and never again. Every update — patch,
 * minor, OR major — leaves an already-onboarded user untouched: their stored
 * setup generation already matches the current one, so `selectSetupScenes`
 * returns nothing and the wizard never re-fires. This is a deliberate product
 * rule: updating veyyon must never drop you back into the setup wizard, the same
 * way a macOS update never re-runs its setup assistant.
 *
 * The gate is a single FIXED integer, intentionally NOT derived from the app
 * version. A returning user's stored `setupVersion` (written when they first
 * onboarded) is >= this value, so the gate skips them forever; a fresh install
 * starts at the default 0, which is below it, so onboarding runs once and then
 * persists the current generation.
 *
 * When a future release genuinely needs an EXISTING user to see one new setup
 * step, do NOT bump this integer — that re-onboards the entire base in full.
 * Instead give that single scene a `shouldRun` guard that detects the missing
 * configuration, so only the users who lack it see only that one step. This
 * constant moves only for a deliberate, wholesale re-onboard of every existing
 * user, which should be vanishingly rare.
 *
 * Kept dependency-free so the cold-launch gate in `main.ts` can answer "is the
 * stored setup generation stale?" without statically importing the full wizard —
 * every scene plus the overlay component and their TUI deps.
 */

/**
 * The current onboarding generation. Fixed, not version-derived: a fresh install
 * (stored 0) is below it and onboards once; every onboarded user is at or above
 * it and is never re-onboarded by any update. Bump ONLY to force a full
 * re-onboard of every existing user (avoid — prefer a per-scene `shouldRun`).
 */
export const CURRENT_SETUP_VERSION = 1;
