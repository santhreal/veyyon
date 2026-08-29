export interface Tab {
	id: string;
	label: string;
	short?: string;
	muted?: boolean;
}

export interface TabBarTheme {
	label: (text: string) => string;
	activeTab: (text: string) => string;
	inactiveTab: (text: string) => string;
	hint: (text: string) => string;
	mutedTab?: (text: string) => string;
	hoverTab?: (text: string, strength: number) => string;
}
