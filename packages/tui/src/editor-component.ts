import type { AutocompleteProvider } from "./autocomplete";
import type { Component } from "./tui";

export interface EditorComponent extends Component {
	getText(): string;

	setText(text: string): void;

	handleInput(data: string): void;

	onSubmit?: (text: string) => void;

	submit?(): void;

	onChange?: (text: string) => void;

	addToHistory?(text: string): void;

	insertTextAtCursor?(text: string): void;

	getExpandedText?(): string;

	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	borderColor?: (str: string) => string;

	setPaddingX?(padding: number): void;
}
