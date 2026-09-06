/**
 * Differential oracle: todo-main-renderer from origin/main.
 * Source SHA: 8b24575522c362f241f404cb0538c59bf2af5d48
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("todo-main-renderer");

export const TODO_STRIKE_HOLD_FRAMES = oracle.TODO_STRIKE_HOLD_FRAMES as number;
export const TODO_STRIKE_REVEAL_FRAMES = oracle.TODO_STRIKE_REVEAL_FRAMES as number;
export const TODO_STRIKE_TOTAL_FRAMES = oracle.TODO_STRIKE_TOTAL_FRAMES as number;
export const todoStrikeReveal = oracle.todoStrikeReveal as (text: string, frame: number | undefined) => string;
export const todoToolRenderer = oracle.todoToolRenderer as LegacyRenderer;
