/**
 * Differential oracle: vibe-main-renderer from origin/main.
 * Source SHA: d0cb967888303de02e573bb8b0f3c5ba6fe66377
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("vibe-main-renderer");

export const createVibeToolRenderer = oracle.createVibeToolRenderer as (op?: string) => LegacyRenderer;
