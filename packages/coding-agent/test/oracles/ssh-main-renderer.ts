/**
 * Differential oracle: ssh-main-renderer from origin/main.
 * Source SHA: 912a1936b7
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("ssh-main-renderer");

export const sshMainRenderer = oracle.sshMainRenderer as LegacyRenderer;
