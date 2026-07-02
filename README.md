# BC-250 Performance

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for devices powered by the AMD BC-250 APU. Control the GPU max clock speed live via a notched slider and monitor system telemetry directly from the Quick Access Menu.

![Screenshot](https://github.com/mix3d/bc250-perf-profile-switcher/raw/main/assets/screenshot-text.png)

## Features

- **GPU clock cap** — notched slider drives the `cyan-skillfish-governor-smu` D-Bus service; selected cap persists across reboots
- **Telemetry** — live GPU/CPU clock speeds, temperatures, and utilization percentages
- **Display modes** — Off, Minimal (current values), or Histogram (scrolling sparklines over the last 5 minutes)
- **Self-update** — the plugin flags new releases with a one-click update

## Requirements

The [`cyan-skillfish-governor-smu`](https://github.com/filippor/cyan-skillfish-governor/tree/smu) service must be installed and running. The plugin looks for the governor config at `/etc/cyan-skillfish-governor-smu/config.toml` and communicates via the `com.cyan.SkillFishGovernor` D-Bus interface.

The plugin requests root access (Decky's `_root` flag) so it can restart Decky's plugin loader as part of self-updating.

## Installation

### Quick install

```bash
curl -L -o install-plugin.sh https://raw.githubusercontent.com/mix3d/bc250-perf-profile-switcher/main/install-plugin.sh
chmod +x install-plugin.sh
sudo ./install-plugin.sh
```

This downloads the latest release, stops Decky's plugin loader, installs the plugin, and restarts the loader.

### Manual install

Sideload via Decky's developer mode.

## Updating

When a newer release is available, the plugin shows an "Update available" banner with an **Update now** button — it downloads the release, restarts Decky's plugin loader, and installs the update in place. If that fails for any reason, re-run the Quick install steps above.

## Building from source

```bash
pnpm i
pnpm run build
```

The built frontend lands in `dist/` and the backend is `main.py`. Deploy with your preferred Decky development workflow.

## License

MIT — see [LICENSE](LICENSE)
