/**
 * Differential oracle: eval-main-renderer from origin/main.
 * Source SHA: d0cb967888303de02e573bb8b0f3c5ba6fe66377
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("eval-main-renderer");

export const EVAL_DEFAULT_PREVIEW_LINES = oracle.EVAL_DEFAULT_PREVIEW_LINES as number;
export const evalToolRenderer = oracle.evalToolRenderer as LegacyRenderer;
