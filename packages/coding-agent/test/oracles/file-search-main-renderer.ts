/**
 * Differential oracle: file-search-main-renderer from origin/main.
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("file-search-main-renderer");

export const fileSearchRenderer = oracle.fileSearchRenderer as LegacyRenderer;
