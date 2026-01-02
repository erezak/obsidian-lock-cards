import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, LockCardsSettingTab, type LockCardsSettings } from "./settings";
import { loadPluginState, savePluginState, type LockedByCanvas } from "./data/pluginData";
import { CanvasLockManager } from "./canvas/CanvasLockManager";

export default class LockCardsPlugin extends Plugin {
  private lockedByCanvas: LockedByCanvas = {};
  settings: LockCardsSettings = { ...DEFAULT_SETTINGS };
  private lockManager: CanvasLockManager | null = null;

  async onload() {
    const state = await loadPluginState(this);
    this.lockedByCanvas = state.lockedByCanvas;
    this.settings = state.settings;

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
      checkCallback: (checking: boolean) => {
        const mgr = this.lockManager;
        if (!mgr) return false;

        const ctx = mgr.getActiveCanvasContext();
        if (!ctx) return false;

        const selectedIds = mgr.getSelectedNodeIds(ctx);
        if (selectedIds.length === 0) return false;

        if (checking) return true;

        mgr.ensureGuardAttached(ctx);

        const anyUnlocked = selectedIds.some((id) => !mgr.isLocked(ctx.canvasPath, id));
        const newLockedState = anyUnlocked;

        for (const id of selectedIds) mgr.setLocked(ctx.canvasPath, id, newLockedState);

        for (const id of selectedIds) {
          if (newLockedState) mgr.snapshotOnLock(ctx, id);
          else mgr.forgetOnUnlock(ctx.canvasPath, id);
        }

        mgr.applyLockedClasses(ctx);
        void this.savePluginData();

        new Notice(newLockedState ? `Locked ${selectedIds.length} card(s).` : `Unlocked ${selectedIds.length} card(s).`);
        return true;
      },
    });

    this.addCommand({
      id: "lock-selected-cards",
      name: "Lock selected canvas cards",
      checkCallback: (checking: boolean) => {
        const mgr = this.lockManager;
        if (!mgr) return false;

        const ctx = mgr.getActiveCanvasContext();
        if (!ctx) return false;

        const selectedIds = mgr.getSelectedNodeIds(ctx);
        if (selectedIds.length === 0) return false;

        if (checking) return true;

        mgr.ensureGuardAttached(ctx);

        for (const id of selectedIds) {
          mgr.setLocked(ctx.canvasPath, id, true);
          mgr.snapshotOnLock(ctx, id);
        }

        mgr.applyLockedClasses(ctx);
        void this.savePluginData();

        new Notice(`Locked ${selectedIds.length} card(s).`);
        return true;
      },
    });

    this.addCommand({
      id: "unlock-selected-cards",
      name: "Unlock selected canvas cards",
      checkCallback: (checking: boolean) => {
        const mgr = this.lockManager;
        if (!mgr) return false;

        const ctx = mgr.getActiveCanvasContext();
        if (!ctx) return false;

        const selectedIds = mgr.getSelectedNodeIds(ctx);
        if (selectedIds.length === 0) return false;

        if (checking) return true;

        mgr.ensureGuardAttached(ctx);

        for (const id of selectedIds) {
          mgr.setLocked(ctx.canvasPath, id, false);
          mgr.forgetOnUnlock(ctx.canvasPath, id);
        }

        mgr.applyLockedClasses(ctx);
        void this.savePluginData();

        new Notice(`Unlocked ${selectedIds.length} card(s).`);
        return true;
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
    await this.savePluginData();
  }

  private async savePluginData() {
    await savePluginState(this, {
      lockedByCanvas: this.lockedByCanvas,
      settings: this.settings,
    });
  }
}
