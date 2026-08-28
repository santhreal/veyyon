import { type Container, Spacer, type TUI } from "@veyyon/tui";
import { type RecentSession, WelcomeComponent } from "../components/welcome";

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

export class WelcomeController {
	#component: WelcomeComponent | undefined;
	#spacers: Spacer[] = [];

	constructor(private readonly port: WelcomeLayoutPort) {}

	get hasHero(): boolean {
		return this.#component !== undefined;
	}

	mountHero(inputs: WelcomeHeroInputs, adopted?: WelcomeComponent): void {
		if (adopted) {
			adopted.setModel(inputs.modelName, inputs.providerName);
			adopted.setRecentSessions(inputs.recentSessions);
		}
		this.#component =
			adopted ?? new WelcomeComponent(inputs.version, inputs.modelName, inputs.providerName, inputs.recentSessions);
		this.#spacers = [new Spacer(1), new Spacer(1)];
		this.port.ui.addChild(this.#spacers[0] as Spacer);
		this.port.ui.addChild(this.#component);
		this.port.ui.addChild(this.#spacers[1] as Spacer);
	}

	dismiss(): void {
		const welcome = this.#component;
		if (!welcome) return;
		this.#component = undefined;
		const width = this.port.ui.terminal.columns;
		const removedRows = welcome.render(width).length + this.#spacers.length + this.port.topFillRows(width);
		for (const spacer of this.#spacers) this.port.ui.removeChild(spacer);
		this.#spacers = [];
		this.port.ui.removeChild(welcome);
		this.port.onHeroDismissed(removedRows);
	}

	showFull(inputs: WelcomeHeroInputs): void {
		const welcome = new WelcomeComponent(
			inputs.version,
			inputs.modelName,
			inputs.providerName,
			inputs.recentSessions,
			[],
			true,
		);
		this.dismiss();
		this.port.chatContainer.addChild(new Spacer(1));
		this.port.chatContainer.addChild(welcome);
		this.port.chatContainer.addChild(new Spacer(1));
		this.port.remeasureAnchor();
	}
}
