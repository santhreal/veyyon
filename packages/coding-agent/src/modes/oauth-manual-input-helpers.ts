export type PendingInput = {
	providerId: string;
	resolve: (_value: string) => void;
	reject: (_error: Error) => void;
};
export type ClaimedInput = {
	promise: Promise<string>;
	clear: (reason?: string) => void;
};
