# Lock Cards

Lock selected Canvas cards to prevent moving and resizing.


![demo](./assets/lock.gif)


## Usage

1. Open a Canvas.
2. Select one or more cards.
3. Run the command **Toggle lock for selected canvas cards**.

Locked cards are visually marked and attempts to move/resize them are reverted.

## Settings

- **Disable lock while alt is held**: temporarily allow moving locked cards by holding alt.

## Install (manual)

Copy these files into:

`<Vault>/.obsidian/plugins/lock-cards/`

- `main.js`
- `manifest.json`
- `styles.css`

Then reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Development

- Install dependencies: `npm install`
- Watch build: `npm run dev`
- Production build: `npm run build`
- Lint: `npm run lint`

## Troubleshooting

- If commands don’t appear, make sure the plugin is enabled and Obsidian has been reloaded.
