/**
 * Plan mode is either OFF (no active plan) or ON with a concrete plan file.
 *
 * The discriminated union encodes that `planFilePath` exists exactly when
 * `enabled` is true: a reader that narrows on `state.enabled === true` (or
 * early-returns on `!state?.enabled`) sees a non-optional `planFilePath`, while
 * the OFF state carries none. Production represents "plan mode off" as `undefined`
 * from `getPlanModeState()`; `{ enabled: false }` is the explicit disabled form
 * (used by tests as a disabled stub and by callers that read `enabled` alone).
 *
 * Modeling this as a plain `{ enabled: boolean; planFilePath: string }` was wrong
 * twice over: it forced every disabled stub to invent a bogus `planFilePath`, and
 * it lied that a disabled state has a plan file. The union removes both.
 */
export type PlanModeState = PlanModeDisabled | PlanModeEnabled;

/** Plan mode is off: no plan file. `planFilePath` is pinned to `undefined` so an
 *  optimistic `state?.planFilePath` read across the union stays `string | undefined`. */
export interface PlanModeDisabled {
	enabled: false;
	planFilePath?: undefined;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
}

/** Plan mode is on: a concrete plan file is always present. */
export interface PlanModeEnabled {
	enabled: true;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
}
