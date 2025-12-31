import type { Workspace } from "obsidian";
import type { LockedByCanvas } from "../data/pluginData";
import type { LockCardsSettings } from "../settings";
import type { CanvasContext, CanvasLike, CanvasViewLike, ModelSnapshot } from "./types";

function isCanvasViewLike(v: unknown): v is CanvasViewLike {
	if (!v || typeof v !== "object") return false;
	const obj = v as Record<string, unknown>;
	return typeof obj.getViewType === "function" && obj.containerEl instanceof HTMLElement;
}

function getCanvasFromView(view: CanvasViewLike): CanvasLike | null {
	const v = view as unknown as Record<string, unknown>;
	const canvas = v["canvas"];
	if (!canvas || typeof canvas !== "object") return null;
	return canvas as CanvasLike;
}

export class CanvasLockManager {
	private lockedStyleByCanvas: Record<string, Record<string, string>> = {};
	private lockedMoveStyleByCanvas: Record<string, Record<string, string>> = {};
	private lockedModelByCanvas: Record<string, Record<string, ModelSnapshot>> = {};

	private observer: MutationObserver | null = null;
	private observedCanvasPath: string | null = null;
	private observedView: CanvasViewLike | null = null;

	private lastRestoreAtByCanvas: Record<string, Record<string, number>> = {};

	private altDown = false;
	private restoring = new WeakSet<HTMLElement>();
	private nodeIdByEl = new WeakMap<HTMLElement, string>();
	private moveElByNodeEl = new WeakMap<HTMLElement, HTMLElement>();
	private inputAbort: AbortController | null = null;
	private enforcementRaf: number | null = null;
	private enforcing = false;
	private pointerIsDown = false;
	private enforceUntil = 0;
	private blockedPointerId: number | null = null;

	constructor(
		private workspace: Workspace,
		private lockedByCanvas: LockedByCanvas,
		private settings: LockCardsSettings,
		private registerDomEvent: (
			el: HTMLElement | Document | Window,
			event: string,
			callback: (evt: Event) => void,
			options?: boolean | AddEventListenerOptions,
		) => void,
		private registerCleanup: (cleanup: () => void) => void,
	) {
		this.installAltKeyTracking();
	}

	dispose() {
		this.observer?.disconnect();
		this.observer = null;
		this.inputAbort?.abort();
		this.inputAbort = null;
		if (this.enforcementRaf !== null) cancelAnimationFrame(this.enforcementRaf);
		this.enforcementRaf = null;
		this.enforcing = false;
	}

	setSettings(settings: LockCardsSettings) {
		this.settings = settings;
	}

	getActiveCanvasContext(): CanvasContext | null {
		const candidates: unknown[] = [
			this.workspace.getMostRecentLeaf(),
			...this.workspace.getLeavesOfType("canvas"),
		].filter(Boolean);

		for (const leaf of candidates) {
			if (!leaf || typeof leaf !== "object") continue;
			const view = (leaf as { view?: unknown }).view;
			if (!isCanvasViewLike(view)) continue;
			if (view.getViewType() !== "canvas") continue;

			const canvasPath = view.file?.path;
			if (!canvasPath) continue;
			return { view, canvasPath };
		}

		return null;
	}

	ensureGuardAttached(ctx: CanvasContext) {
		this.attachStyleGuardToCanvas(ctx.view, ctx.canvasPath);
	}

	applyLockedClasses(ctx: CanvasContext) {
		const container = ctx.view.containerEl;
		for (const node of Array.from(container.querySelectorAll<HTMLElement>(".canvas-node"))) {
			node.classList.remove("lc-locked");
		}

		const lockedIds = this.lockedByCanvas[ctx.canvasPath] ?? [];
		for (const id of lockedIds) {
			const el = this.resolveNodeElById(ctx.view, id);
			if (el) el.classList.add("lc-locked");
		}
	}

	unlockAllInCanvas(ctx: CanvasContext): number {
		const lockedIds = this.lockedByCanvas[ctx.canvasPath] ?? [];
		if (lockedIds.length === 0) return 0;

		for (const id of lockedIds) {
			this.forgetOnUnlock(ctx.canvasPath, id);
		}

		this.lockedByCanvas[ctx.canvasPath] = [];
		this.applyLockedClasses(ctx);
		return lockedIds.length;
	}

	primeLockedSnapshots(ctx: CanvasContext) {
		const lockedIds = this.lockedByCanvas[ctx.canvasPath] ?? [];
		if (lockedIds.length === 0) return;

		for (const id of lockedIds) {
			if (this.lockedStyleByCanvas[ctx.canvasPath]?.[id] === undefined) {
				const el = this.resolveNodeElById(ctx.view, id);
				if (el) this.snapshotLockedNodeStyle(ctx.canvasPath, id, el);
			}

			if (this.lockedModelByCanvas[ctx.canvasPath]?.[id] === undefined) {
				this.snapshotLockedNodeModel(ctx, id);
			}
		}
	}

	getSelectedNodeIds(ctx: CanvasContext): string[] {
		return this.getSelectedCanvasNodeIdsFromInternalSelection(ctx.view);
	}

	isLocked(canvasPath: string, nodeId: string): boolean {
		return (this.lockedByCanvas[canvasPath] ?? []).includes(nodeId);
	}

	setLocked(canvasPath: string, nodeId: string, locked: boolean) {
		const current = new Set(this.lockedByCanvas[canvasPath] ?? []);
		if (locked) current.add(nodeId);
		else current.delete(nodeId);
		this.lockedByCanvas[canvasPath] = Array.from(current);
	}

	snapshotOnLock(ctx: CanvasContext, nodeId: string) {
		const el = this.resolveNodeElById(ctx.view, nodeId);
		if (!el) return;
		this.nodeIdByEl.set(el, nodeId);
		this.snapshotLockedNodeStyle(ctx.canvasPath, nodeId, el);
		this.snapshotLockedMoveStyle(ctx.canvasPath, nodeId, el);
		this.snapshotLockedNodeModel(ctx, nodeId);
	}

	forgetOnUnlock(canvasPath: string, nodeId: string) {
		this.forgetLockedNodeStyle(canvasPath, nodeId);
		this.forgetLockedMoveStyle(canvasPath, nodeId);
		this.forgetLockedNodeModel(canvasPath, nodeId);
	}

	private getSelectedCanvasNodeIdsFromInternalSelection(view: CanvasViewLike): string[] {
		const canvas = getCanvasFromView(view);
		if (!canvas) return [];

		const sel = canvas.selection;
		if (!sel) return [];

		const out: string[] = [];

		if (sel instanceof Set) {
			for (const item of sel) {
				if (typeof item === "string") out.push(item);
				else if (item && typeof item === "object") {
					const maybeId = (item as { id?: unknown }).id;
					if (typeof maybeId === "string") out.push(maybeId);
				}
			}
			return out;
		}

		if (typeof sel === "object") {
			const obj = sel as Record<string, unknown>;
			for (const key of ["nodes", "selectedNodes", "items"]) {
				const v = obj[key];
				if (v instanceof Set) {
					for (const item of v) {
						if (typeof item === "string") out.push(item);
						else if (item && typeof item === "object") {
							const maybeId = (item as { id?: unknown }).id;
							if (typeof maybeId === "string") out.push(maybeId);
						}
					}
					if (out.length > 0) return out;
				}
				if (Array.isArray(v)) {
					for (const item of v) {
						if (typeof item === "string") out.push(item);
						else if (item && typeof item === "object") {
							const maybeId = (item as { id?: unknown }).id;
							if (typeof maybeId === "string") out.push(maybeId);
						}
					}
					if (out.length > 0) return out;
				}
			}

			const maybeIterable = sel as Partial<Iterable<unknown>>;
			const maybeIter = maybeIterable[Symbol.iterator];
			if (typeof maybeIter === "function") {
				for (const item of sel as Iterable<unknown>) {
					if (typeof item === "string") out.push(item);
					else if (item && typeof item === "object") {
						const maybeId = (item as { id?: unknown }).id;
						if (typeof maybeId === "string") out.push(maybeId);
					}
				}
				if (out.length > 0) return out;
			}
		}

		return [];
	}

	private resolveNodeElById(view: CanvasViewLike, id: string): HTMLElement | null {
		const canvas = getCanvasFromView(view);

		const nodes = canvas?.nodes;
		if (nodes instanceof Map) {
			const nodeObj = nodes.get(id) as unknown;
			if (nodeObj && typeof nodeObj === "object") {
				const o = nodeObj as Record<string, unknown>;
				const candidates = [o["nodeEl"], o["el"], o["containerEl"], o["contentEl"]];
				for (const c of candidates) {
					if (c instanceof HTMLElement) {
						const nodeEl = c.classList.contains("canvas-node")
							? c
							: c.closest<HTMLElement>(".canvas-node");
						if (nodeEl) {
							this.nodeIdByEl.set(nodeEl, id);
							return nodeEl;
						}
					}
				}
			}
		}

		const container = view.containerEl;
		const selectors = [
			`.canvas-node[data-node-id="${id}"]`,
			`.canvas-node[data-id="${id}"]`,
			`.canvas-node[data-node="${id}"]`,
			`.canvas-node[data-uid="${id}"]`,
			`#${CSS.escape(id)}`,
		];

		for (const sel of selectors) {
			const el = container.querySelector<HTMLElement>(sel);
			if (!el) continue;
			const nodeEl = el.classList.contains("canvas-node")
				? el
				: el.closest<HTMLElement>(".canvas-node");
			if (nodeEl) {
				this.nodeIdByEl.set(nodeEl, id);
				return nodeEl;
			}
		}

		return null;
	}

	private snapshotLockedNodeStyle(canvasPath: string, nodeId: string, nodeEl: HTMLElement) {
		if (!this.lockedStyleByCanvas[canvasPath]) this.lockedStyleByCanvas[canvasPath] = {};
		this.lockedStyleByCanvas[canvasPath][nodeId] = nodeEl.getAttribute("style") ?? "";
	}

	private snapshotLockedMoveStyle(canvasPath: string, nodeId: string, nodeEl: HTMLElement) {
		const moveEl = this.findMoveElement(nodeEl);
		this.moveElByNodeEl.set(nodeEl, moveEl);
		if (!this.lockedMoveStyleByCanvas[canvasPath]) this.lockedMoveStyleByCanvas[canvasPath] = {};
		this.lockedMoveStyleByCanvas[canvasPath][nodeId] = moveEl.getAttribute("style") ?? "";
	}

	private forgetLockedNodeStyle(canvasPath: string, nodeId: string) {
		const map = this.lockedStyleByCanvas[canvasPath];
		if (!map) return;
		delete map[nodeId];
	}

	private forgetLockedMoveStyle(canvasPath: string, nodeId: string) {
		const map = this.lockedMoveStyleByCanvas[canvasPath];
		if (!map) return;
		delete map[nodeId];
	}

	private findMoveElement(nodeEl: HTMLElement): HTMLElement {
		const hasInlinePositionProps = (el: HTMLElement): boolean => {
			const style = el.getAttribute("style");
			if (!style) return false;
			return (
				style.includes("transform") ||
				style.includes("left") ||
				style.includes("top") ||
				style.includes("width") ||
				style.includes("height")
			);
		};

		// In some Obsidian versions, the element that actually moves is a wrapper around
		// `.canvas-node`. Prefer the first ancestor with inline position props.
		let cursor: HTMLElement | null = nodeEl;
		for (let i = 0; i < 3 && cursor; i++) {
			if (hasInlinePositionProps(cursor)) return cursor;
			cursor = cursor.parentElement;
		}

		return nodeEl;
	}

	private snapshotLockedNodeModel(ctx: CanvasContext, nodeId: string) {
		const snap = this.readModelSnapshot(ctx.view, nodeId);
		if (!snap) return;
		const map = (this.lockedModelByCanvas[ctx.canvasPath] ??= {});
		map[nodeId] = snap;
	}

	private forgetLockedNodeModel(canvasPath: string, nodeId: string) {
		const map = this.lockedModelByCanvas[canvasPath];
		if (!map) return;
		delete map[nodeId];
	}

	private readModelSnapshot(view: CanvasViewLike, nodeId: string): ModelSnapshot | null {
		const canvas = getCanvasFromView(view);
		const nodes = canvas?.nodes;
		if (!(nodes instanceof Map)) return null;

		const nodeObj = nodes.get(nodeId) as unknown;
		if (!nodeObj || typeof nodeObj !== "object") return null;

		const o = nodeObj as Record<string, unknown>;

		const fromObj = (base: unknown, mode: ModelSnapshot["mode"]): ModelSnapshot | null => {
			if (!base || typeof base !== "object") return null;
			const b = base as Record<string, unknown>;
			const x = b["x"];
			const y = b["y"];
			if (typeof x !== "number" || typeof y !== "number") return null;

			const w = b["width"];
			const h = b["height"];
			const w2 = b["w"];
			const h2 = b["h"];

			return {
				mode,
				x,
				y,
				w: typeof w === "number" ? w : typeof w2 === "number" ? w2 : undefined,
				h: typeof h === "number" ? h : typeof h2 === "number" ? h2 : undefined,
			};
		};

		return (
			fromObj(o, "top") ||
			fromObj(o["pos"], "pos") ||
			fromObj(o["rect"], "rect") ||
			fromObj(o["data"], "data") ||
			null
		);
	}

	private restoreModelSnapshot(view: CanvasViewLike, nodeId: string, snap: ModelSnapshot) {
		const canvas = getCanvasFromView(view);
		const nodes = canvas?.nodes;
		if (!(nodes instanceof Map)) return;

		const nodeObj = nodes.get(nodeId) as unknown;
		if (!nodeObj || typeof nodeObj !== "object") return;

		const o = nodeObj as Record<string, unknown>;

		const applyTo = (base: unknown): boolean => {
			if (!base || typeof base !== "object") return false;
			const b = base as Record<string, unknown>;

			if (typeof b["x"] === "number") b["x"] = snap.x;
			else return false;

			if (typeof b["y"] === "number") b["y"] = snap.y;
			else return false;

			if (snap.w !== undefined) {
				if (typeof b["width"] === "number") b["width"] = snap.w;
				else if (typeof b["w"] === "number") b["w"] = snap.w;
			}

			if (snap.h !== undefined) {
				if (typeof b["height"] === "number") b["height"] = snap.h;
				else if (typeof b["h"] === "number") b["h"] = snap.h;
			}

			return true;
		};

		const bases: unknown[] =
			snap.mode === "top"
				? [o, o["pos"], o["rect"], o["data"]]
				: snap.mode === "pos"
					? [o["pos"], o, o["rect"], o["data"]]
					: snap.mode === "rect"
						? [o["rect"], o, o["pos"], o["data"]]
						: snap.mode === "data"
							? [o["data"], o, o["pos"], o["rect"]]
							: [o, o["pos"], o["rect"], o["data"]];

		for (const base of bases) {
			if (applyTo(base)) break;
		}

		const maybeMethods = ["requestRender", "requestFrame", "render", "redraw"];
		const canvasObj = canvas as unknown as Record<string, unknown>;
		for (const m of maybeMethods) {
			const fn = canvasObj[m];
			if (typeof fn === "function") {
				try {
					(fn as () => void)();
					break;
				} catch {
					// ignore
				}
			}
		}
	}

	private installAltKeyTracking() {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Alt") this.altDown = true;
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.key === "Alt") this.altDown = false;
		};

		this.registerDomEvent(document, "keydown", onKeyDown, true);
		this.registerDomEvent(document, "keyup", onKeyUp, true);
	}

	private attachStyleGuardToCanvas(view: CanvasViewLike, canvasPath: string) {
		if (this.observer && this.observedCanvasPath === canvasPath) return;

		this.observer?.disconnect();
		this.observer = null;

		this.observedCanvasPath = canvasPath;
		this.observedView = view;
		this.attachInputGuardToCanvas(view);

		const container = view.containerEl;

		const isSameSnapshot = (a: ModelSnapshot, b: ModelSnapshot): boolean => {
			const eps = 0.0001;
			const close = (x: number, y: number) => Math.abs(x - y) <= eps;

			if (!close(a.x, b.x) || !close(a.y, b.y)) return false;

			const aw = a.w;
			const bw = b.w;
			if (aw === undefined || bw === undefined) {
				if (aw !== bw) return false;
			} else if (!close(aw, bw)) return false;

			const ah = a.h;
			const bh = b.h;
			if (ah === undefined || bh === undefined) {
				if (ah !== bh) return false;
			} else if (!close(ah, bh)) return false;

			return true;
		};

		const shouldThrottleRestore = (nodeId: string): boolean => {
			if (!this.lastRestoreAtByCanvas[canvasPath]) this.lastRestoreAtByCanvas[canvasPath] = {};
			const now = Date.now();
			const last = this.lastRestoreAtByCanvas[canvasPath][nodeId] ?? 0;
			if (now - last < 50) return true;
			this.lastRestoreAtByCanvas[canvasPath][nodeId] = now;
			return false;
		};

		const restorePositionStyleOnly = (nodeEl: HTMLElement, savedStyle: string) => {
			const tmp = document.createElement("div");
			tmp.setAttribute("style", savedStyle);
			const saved = tmp.style;
			const current = nodeEl.style;

			const props = ["left", "top", "width", "height", "transform"] as const;
			for (const prop of props) {
				const v = saved.getPropertyValue(prop);
				if (v) current.setProperty(prop, v);
				else current.removeProperty(prop);
			}
		};

		this.observer = new MutationObserver((mutations) => {
			if (this.settings.disableLockWhileAltDown && this.altDown) return;
			if (!this.observedView) return;

			for (const m of mutations) {
				if (m.type !== "attributes") continue;

				const target = m.target;
				if (!(target instanceof HTMLElement)) continue;

				const nodeEl =
					target.classList.contains("canvas-node")
						? target
						: target.closest<HTMLElement>(".canvas-node") ??
							target.querySelector<HTMLElement>(".canvas-node.lc-locked");

				if (!nodeEl) continue;
				if (!nodeEl.classList.contains("lc-locked")) continue;

				const nodeId = this.nodeIdByEl.get(nodeEl);
				if (!nodeId) continue;

				const savedStyle = this.lockedStyleByCanvas[canvasPath]?.[nodeId];
				const savedMoveStyle = this.lockedMoveStyleByCanvas[canvasPath]?.[nodeId];
				const savedModel = this.lockedModelByCanvas[canvasPath]?.[nodeId];
				if (savedStyle === undefined && savedMoveStyle === undefined && savedModel === undefined) continue;
				if (this.restoring.has(nodeEl)) continue;

				this.restoring.add(nodeEl);
				try {
					// Prefer model-based restore (robust and ignores handle/UI style changes).
					if (savedModel && this.observedView) {
						const currentModel = this.readModelSnapshot(this.observedView, nodeId);
						if (!currentModel || !isSameSnapshot(currentModel, savedModel)) {
							if (!shouldThrottleRestore(nodeId)) {
								this.restoreModelSnapshot(this.observedView, nodeId, savedModel);
							}
						}
						continue;
					}

					// Style-based fallback:
					// Restore the element that actually moves (often the node itself, sometimes a wrapper).
					// This is applied even for descendant mutations so that drag operations that update
					// inner elements still get reverted.
					const moveEl = this.moveElByNodeEl.get(nodeEl) ?? nodeEl;
					if (savedMoveStyle !== undefined) restorePositionStyleOnly(moveEl, savedMoveStyle);
					else if (savedStyle !== undefined) restorePositionStyleOnly(nodeEl, savedStyle);
				} finally {
					queueMicrotask(() => this.restoring.delete(nodeEl));
				}
			}
		});

		this.observer.observe(container, {
			subtree: true,
			attributes: true,
			attributeFilter: ["style"],
		});

		this.registerCleanup(() => this.observer?.disconnect());
	}

	private attachInputGuardToCanvas(view: CanvasViewLike) {
		// Reset per-canvas listeners when switching canvases.
		this.inputAbort?.abort();
		this.inputAbort = new AbortController();
		const signal = this.inputAbort.signal;

		const container = view.containerEl;

		const shouldBypass = (): boolean =>
			this.settings.disableLockWhileAltDown && this.altDown;

		const onPointerDown = (e: PointerEvent) => {
			this.pointerIsDown = true;
			if (shouldBypass()) return;

			// If the interaction begins on a locked node, block pointermove so Canvas never
			// receives drag/resize move events. We intentionally do not block pointerdown so
			// selection still works.
			const t = e.target;
			if (t instanceof HTMLElement) {
				const lockedNode = t.closest<HTMLElement>(".canvas-node.lc-locked");
				if (lockedNode) {
					this.blockedPointerId = e.pointerId;
				}
			}

			this.startEnforcementLoop(Number.POSITIVE_INFINITY);
		};

		const onPointerMove = (e: PointerEvent) => {
			if (shouldBypass()) return;
			if (this.blockedPointerId === null) return;
			if (e.pointerId !== this.blockedPointerId) return;

			e.preventDefault();
			e.stopImmediatePropagation();
		};

		const onPointerUp = () => {
			this.pointerIsDown = false;
			this.blockedPointerId = null;
			if (shouldBypass()) return;
			// Keep enforcing briefly after release to catch late renders.
			this.startEnforcementLoop(Date.now() + 250);
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (shouldBypass()) return;
			// Catch keyboard moves / nudges.
			if (
				e.key === "ArrowUp" ||
				e.key === "ArrowDown" ||
				e.key === "ArrowLeft" ||
				e.key === "ArrowRight"
			) {
				this.startEnforcementLoop(Date.now() + 400);
			}
		};

		container.addEventListener("pointerdown", onPointerDown, { capture: true, signal });
		window.addEventListener("pointermove", onPointerMove, { capture: true, signal });
		window.addEventListener("pointerup", onPointerUp, { capture: true, signal });
		window.addEventListener("pointercancel", onPointerUp, { capture: true, signal });
		document.addEventListener("keydown", onKeyDown, { capture: true, signal });

		this.registerCleanup(() => this.inputAbort?.abort());
	}

	private startEnforcementLoop(until: number) {
		this.enforceUntil = Math.max(this.enforceUntil, until);
		if (this.enforcing) return;
		this.enforcing = true;
		const tick = () => {
			if (!this.enforcing) return;
			const now = Date.now();
			const shouldBypass = this.settings.disableLockWhileAltDown && this.altDown;

			if (!shouldBypass) {
				this.enforceLockedNodesOnce();
			}

			if (this.pointerIsDown || now < this.enforceUntil) {
				this.enforcementRaf = requestAnimationFrame(tick);
				return;
			}

			this.enforcing = false;
			this.enforcementRaf = null;
			this.enforceUntil = 0;
		};

		this.enforcementRaf = requestAnimationFrame(tick);
	}

	private enforceLockedNodesOnce() {
		const view = this.observedView;
		const canvasPath = this.observedCanvasPath;
		if (!view || !canvasPath) return;

		const lockedIds = this.lockedByCanvas[canvasPath] ?? [];
		if (lockedIds.length === 0) return;

		const isSameSnapshot = (a: ModelSnapshot, b: ModelSnapshot): boolean => {
			const eps = 0.0001;
			const close = (x: number, y: number) => Math.abs(x - y) <= eps;
			if (!close(a.x, b.x) || !close(a.y, b.y)) return false;

			const aw = a.w;
			const bw = b.w;
			if (aw === undefined || bw === undefined) {
				if (aw !== bw) return false;
			} else if (!close(aw, bw)) return false;

			const ah = a.h;
			const bh = b.h;
			if (ah === undefined || bh === undefined) {
				if (ah !== bh) return false;
			} else if (!close(ah, bh)) return false;

			return true;
		};

		const restorePositionStyleOnly = (nodeEl: HTMLElement, savedStyle: string) => {
			const tmp = document.createElement("div");
			tmp.setAttribute("style", savedStyle);
			const saved = tmp.style;
			const current = nodeEl.style;

			const props = ["left", "top", "width", "height", "transform"] as const;
			for (const prop of props) {
				const v = saved.getPropertyValue(prop);
				if (v) current.setProperty(prop, v);
				else current.removeProperty(prop);
			}
		};

		for (const nodeId of lockedIds) {
			const el = this.resolveNodeElById(view, nodeId);
			if (!el) continue;
			this.nodeIdByEl.set(el, nodeId);

			const savedModel = this.lockedModelByCanvas[canvasPath]?.[nodeId];
			if (savedModel) {
				const currentModel = this.readModelSnapshot(view, nodeId);
				if (!currentModel || !isSameSnapshot(currentModel, savedModel)) {
					this.restoreModelSnapshot(view, nodeId, savedModel);
				}
				continue;
			}

			const savedMoveStyle = this.lockedMoveStyleByCanvas[canvasPath]?.[nodeId];
			if (savedMoveStyle !== undefined) {
				const moveEl = this.moveElByNodeEl.get(el) ?? this.findMoveElement(el);
				this.moveElByNodeEl.set(el, moveEl);
				restorePositionStyleOnly(moveEl, savedMoveStyle);
				continue;
			}

			const savedStyle = this.lockedStyleByCanvas[canvasPath]?.[nodeId];
			if (savedStyle !== undefined) restorePositionStyleOnly(el, savedStyle);
		}
	}
}
