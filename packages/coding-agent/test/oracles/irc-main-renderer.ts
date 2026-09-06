/**
 * Differential oracle: irc-main-renderer from origin/main.
 * Source SHA: 9d4cccdbbb7d372de9cc36f3327b065cd64b4561
 */
import type { IrcMessageCard } from "@veyyon/coding-agent/modes/terminal/components/transcript/irc-message";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("irc-main-renderer");

export const createIrcMessageCard = oracle.createIrcMessageCard as (
	card: IrcMessageCard,
	getExpanded: () => boolean,
	uiTheme: Theme,
) => Component;
export const ircToolRenderer = oracle.ircToolRenderer as LegacyRenderer;
