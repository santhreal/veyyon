/** Plan mode is either OFF (no active plan) or ON with a concrete plan file. The discriminated union encodes that `planFilePath` exists exactly when */
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
