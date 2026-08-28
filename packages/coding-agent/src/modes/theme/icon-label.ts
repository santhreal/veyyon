/** Join an icon to the text it labels, leaving no gap when the icon is empty. An icon in a symbol preset is allowed to be EMPTY, and in the unicode preset */
export function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}
