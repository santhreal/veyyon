/**
 * Differential oracle: search-tool-bm25-main-renderer from origin/main.
 * Source SHA: 26dc69529c717ffa597feeb29244386afb511fa1
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("search-tool-bm25-main-renderer");

export const searchToolBm25Renderer = oracle.searchToolBm25Renderer as LegacyRenderer;
