import type { ExtensionFactory } from "@veyyon/coding-agent";
import { Container, Text } from "@veyyon/tui";

const extension: ExtensionFactory = pi => {
	pi.setLabel("Thinking note");
	pi.registerAssistantThinkingRenderer((context, theme) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0));
		return container;
	});
};

export default extension;
