/**
 * Differential oracle: ast-edit-main-renderer from origin/main.
 * Source SHA: 9636f6161beaa0522368820c4a1735eca63ac18e
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("ast-edit-main-renderer");

export const astEditToolRenderer = oracle.astEditToolRenderer as LegacyRenderer;
