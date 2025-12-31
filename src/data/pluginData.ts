import type { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type LockCardsSettings } from "../settings/types";
import { isRecord } from "../utils/guards";

export type LockedByCanvas = Record<string, string[]>;

type PluginDataV1 = {
	version: 1;
	lockedByCanvas: LockedByCanvas;
	settings: LockCardsSettings;
};

export type LoadedPluginState = {
	lockedByCanvas: LockedByCanvas;
	settings: LockCardsSettings;
};

export async function loadPluginState(plugin: Plugin): Promise<LoadedPluginState> {
	const loaded: unknown = await plugin.loadData();
	if (!loaded || typeof loaded !== "object") {
		return { lockedByCanvas: {}, settings: { ...DEFAULT_SETTINGS } };
	}

	const maybe = loaded as Partial<PluginDataV1> & Record<string, unknown>;
	if (maybe.version === 1) {
		const lockedByCanvas = maybe.lockedByCanvas ?? {};

		const rawSettings = isRecord(maybe.settings) ? maybe.settings : null;
		const disableLockWhileAltDown = rawSettings?.["disableLockWhileAltDown"] === false ? false : true;
		const enableDebugLogging = rawSettings?.["enableDebugLogging"] === true;

		return {
			lockedByCanvas,
			settings: { ...DEFAULT_SETTINGS, disableLockWhileAltDown, enableDebugLogging },
		};
	}

	// Back-compat: older data stored just the locked map.
	return { lockedByCanvas: loaded as LockedByCanvas, settings: { ...DEFAULT_SETTINGS } };
}

export async function savePluginState(
	plugin: Plugin,
	state: LoadedPluginState,
): Promise<void> {
	const data: PluginDataV1 = {
		version: 1,
		lockedByCanvas: state.lockedByCanvas,
		settings: state.settings,
	};

	await plugin.saveData(data);
}
