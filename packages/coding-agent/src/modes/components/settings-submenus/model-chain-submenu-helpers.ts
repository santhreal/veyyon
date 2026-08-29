export const CHAIN_ENTRY_PREFIX = "\u0000chain-entry:";
export const CHAIN_ADD_ROW = "\u0000chain-add-row";
export const CHAIN_CLEAR_ROW = "\u0000chain-clear-row";

export interface ModelChainSlot {
	write: (chain: string[] | undefined) => void;
}
