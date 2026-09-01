export type Cache = {
	width: number;
	bgSample: string | undefined;
	borderSample: string | undefined;
	childLines: (readonly string[])[];
	result: string[];
};

export interface BoxBorder {
	chars: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};
	color?: (text: string) => string;
}
