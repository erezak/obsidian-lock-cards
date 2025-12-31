import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, LockCardsSettingTab, type LockCardsSettings } from "./settings";
import { loadPluginState, savePluginState, type LockedByCanvas } from "./data/pluginData";
import { CanvasLockManager } from "./canvas/CanvasLockManager";
import { createDebugLogger, type DebugLogger } from "./utils/logger";

export default class LockCardsPlugin extends Plugin {
  private lockedByCanvas: LockedByCanvas = {};
  settings: LockCardsSettings = { ...DEFAULT_SETTINGS };
  private lockManager: CanvasLockManager | null = null;
  private logger: DebugLogger = createDebugLogger({
    getEnabled: () => false,
    prefix: "lock-cards",
  });

  async onload() {
    const state = await loadPluginState(this);
    this.lockedByCanvas = state.lockedByCanvas;
    this.settings = state.settings;

		this.logger = createDebugLogger({
      getEnabled: () => this.settings.enableDebugLogging === true,
			prefix: "lock-cards",
		});

    this.lockManager = new CanvasLockManager(
      this.app.workspace,
      this.lockedByCanvas,
      this.settings,
      this.registerDomEvent.bind(this),
      this.register.bind(this),
    );

    this.addSettingTab(new LockCardsSettingTab(this.app, this));

    this.addCommand({
      id: "toggle-lock-selected-cards",
      name: "Toggle lock for selected canvas cards",
      callback: () => {
        const mgr = this.lockManager;
        if (!mgr) return;

        const ctx = mgr.getActiveCanvasContext();
        if (!ctx) return void new Notice("Open a canvas first.");

        mgr.ensureGuardAttached(ctx);

        const selectedIds = mgr.getSelectedNodeIds(ctx);
        if (selectedIds.length === 0) return void new Notice("Select one or more canvas cards first.");

        const anyUnlocked = selectedIds.some((id) => !mgr.isLocked(ctx.canvasPath, id));
        const newLockedState = anyUnlocked;

        for (const id of selectedIds) mgr.setLocked(ctx.canvasPath, id, newLockedState);

        for (const id of selectedIds) {
          if (newLockedState) mgr.snapshotOnLock(ctx, id);
          else mgr.forgetOnUnlock(ctx.canvasPath, id);
        }

        mgr.applyLockedClasses(ctx);
        void this.savePluginData();

      this.logger.debug("Toggled lock", {
        canvasPath: ctx.canvasPath,
        locked: newLockedState,
        count: selectedIds.length,
        selectedIds,
      });

        new Notice(newLockedState ? `Locked ${selectedIds.length} card(s).` : `Unlocked ${selectedIds.length} card(s).`);
      },
    });

    this.addCommand({
      id: "unlock-all-cards-in-active-canvas",
      name: "Unlock all cards in active canvas",
      callback: () => {
        const mgr = this.lockManager;
        if (!mgr) return;

        const ctx = mgr.getActiveCanvasContext();
        if (!ctx) return void new Notice("Open a canvas first.");

        const count = mgr.unlockAllInCanvas(ctx);
        if (count === 0) return void new Notice("No locked cards to unlock.");

        void this.savePluginData();
        new Notice(`Unlocked ${count} card(s).`);
      },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const mgr = this.lockManager;
        if (!mgr) return;

        const ctx = mgr.getActiveCanvasContext();
        if (!ctx) return;

        mgr.ensureGuardAttached(ctx);
        mgr.applyLockedClasses(ctx);
        mgr.primeLockedSnapshots(ctx);

			this.logger.debug("Active leaf changed; applied lock state", {
				canvasPath: ctx.canvasPath,
			});
      }),
    );

    // Best-effort: apply lock markers on startup if a canvas is active.
    const mgr = this.lockManager;
    const ctx = mgr?.getActiveCanvasContext();
    if (mgr && ctx) {
      mgr.ensureGuardAttached(ctx);
      mgr.applyLockedClasses(ctx);
      mgr.primeLockedSnapshots(ctx);
    }
  }

  onunload() {
    this.lockManager?.dispose();
    this.lockManager = null;
  }

  async saveSettings() {
    this.lockManager?.setSettings(this.settings);
		this.logger?.debug("Settings updated", {
			disableLockWhileAltDown: this.settings.disableLockWhileAltDown,
			enableDebugLogging: this.settings.enableDebugLogging,
		});
    await this.savePluginData();
  }

  private async savePluginData() {
    await savePluginState(this, {
      lockedByCanvas: this.lockedByCanvas,
      settings: this.settings,
    });
  }
}