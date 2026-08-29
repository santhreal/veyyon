import { formatProviderName } from "../../../slash-commands/helpers/format";
import { theme } from "../../theme/theme";

export function loginUrlLink(url: string): string {
	return `\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`;
}

export function loginCopyHint(): string {
	return theme.fg("dim", "(clipboard copy attempted; Alt+C retries)");
}

export function providerDisplayName(providerId: string): string {
	return formatProviderName(providerId);
}
