export type Bounds = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};

export type TextBox = {
	id: string;
	text: string;
	bounds: Bounds;
	pageNumber: number;
	fontSize: number;
	isBold: boolean;
};

export type Segment = {
	id: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
};

export type TableCell = {
	row: number;
	col: number;
	text: string;
	rowSpan: number;
	colSpan: number;
};

export type TableGrid = {
	pageNumber: number;
	rows: number;
	cols: number;
	cells: TableCell[];
	warnings: string[];
	topY: number;
};

export type ImageRegion = {
	id: string;
	pageNumber: number;
	bbox: {
		x: number;
		y: number;
		w: number;
		h: number;
	};
	topY: number;
};

export type PageContent = {
	pageNumber: number;
	textBoxes: TextBox[];
	segments: Segment[];
	images: ImageRegion[];
};

export type ContentBlock = {
	topY: number;
	content: string;
	isTabular?: boolean;
};
