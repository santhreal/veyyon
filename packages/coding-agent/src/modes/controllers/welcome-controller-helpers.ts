import type { Container, TUI } from "@veyyon/tui";
import type { RecentSession } from "../components/welcome";

export interface WelcomeHeroInputs {
	version: string;
	modelName: string;
	providerName: string;
	recentSessions: RecentSession[];
}

export interface WelcomeLayoutPort {
	ui: TUI;
	chatContainer: Container;
	topFillRows(width: number): number;
	onHeroDismissed(removedRows: number): void;
	remeasureAnchor(): void;
}
