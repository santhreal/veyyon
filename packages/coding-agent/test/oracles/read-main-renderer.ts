/**
 * Differential oracle: read-main-renderer from origin/main.
 * Source SHA: d0cb967888303de02e573bb8b0f3c5ba6fe66377
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("read-main-renderer");

export const readToolRenderer = oracle.readToolRenderer as LegacyRenderer;
