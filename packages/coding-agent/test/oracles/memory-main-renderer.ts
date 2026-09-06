/**
 * Differential oracle: memory-main-renderer from origin/main.
 * Source SHA: 80cf11d2f49c9535a7e4d51a38506619035b4720
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("memory-main-renderer");

export const retainToolRenderer = oracle.retainToolRenderer as LegacyRenderer;
export const recallToolRenderer = oracle.recallToolRenderer as LegacyRenderer;
export const reflectToolRenderer = oracle.reflectToolRenderer as LegacyRenderer;
