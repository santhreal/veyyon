/** Task tool renderer export. Separated from render.ts to avoid circular dependency issues with */
import { renderCall, renderResult } from "./render";

export const taskToolRenderer = {
	renderCall,
	renderResult,
	mergeCallAndResult: true,
} as const;
