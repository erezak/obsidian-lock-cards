export interface CanvasViewLike {
	getViewType(): string;
	containerEl: HTMLElement;
	file?: { path: string };
}

export type CanvasLike = {
	selection?: unknown;
	nodes?: unknown;
};

export type CanvasContext = {
	view: CanvasViewLike;
	canvasPath: string;
};

export type ModelSnapshot = {
	mode: "top" | "pos" | "rect" | "data" | "unknown";
	x: number;
	y: number;
	w?: number;
	h?: number;
};
