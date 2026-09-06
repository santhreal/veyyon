/**
 * Differential oracle: search-main-renderer from origin/main.
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("search-main-renderer");

export const searchToolRenderer = oracle.searchToolRenderer as LegacyRenderer;
