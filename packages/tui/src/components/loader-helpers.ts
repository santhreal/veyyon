export const RENDER_INTERVAL_MS = 1000 / 30;
export const SPINNER_ADVANCE_MS = 80;

export type ColorFn = (str: string) => string;

export type LoaderMessageColorFn = ColorFn & {
	readonly animated?: true;
};
