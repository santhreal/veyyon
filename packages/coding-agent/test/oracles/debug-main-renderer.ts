/**
 * Differential oracle: debug-main-renderer from origin/main.
 * Source SHA: 80cf11d2f49c9535a7e4d51a38506619035b4720
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("debug-main-renderer");

export const debugToolRenderer = oracle.debugToolRenderer as LegacyRenderer;
