/**
 * Differential oracle: text-search-main-renderer from origin/main.
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("text-search-main-renderer");

export const textSearchRenderer = oracle.textSearchRenderer as LegacyRenderer;
