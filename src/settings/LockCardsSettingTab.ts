import { App, PluginSettingTab, Setting, type Plugin } from "obsidian";
import type { LockCardsSettings } from "./types";

export type LockCardsPluginLike = Plugin & {
	settings: LockCardsSettings;
	saveSettings: () => Promise<void>;
};

export class LockCardsSettingTab extends PluginSettingTab {
	plugin: LockCardsPluginLike;

	constructor(app: App, plugin: LockCardsPluginLike) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Disable lock while alt is held")
			.setDesc("Temporarily allow moving locked cards by holding alt.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.disableLockWhileAltDown)
					.onChange(async (value) => {
						this.plugin.settings.disableLockWhileAltDown = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
