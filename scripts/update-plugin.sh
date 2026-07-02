# Runs the in-place self-update, triggered from the plugin's own backend
# (main.py's update_plugin). Launched via `systemd-run` so this process lives
# outside plugin_loader.service's cgroup — otherwise `systemctl stop
# plugin_loader.service` below would kill this script too, since it would
# normally share a cgroup with the process that spawned it.
#
# Runs detached, so stdout/stderr land in the systemd journal, not decky's
# plugin log — inspect with `journalctl -u bc250-plugin-update -e`.
#
# Usage: update-plugin.sh <plugins-dir>

set -u

echo "=== BC250 self-update starting (pid $$) ==="

PLUGINS_DIR="$1"
if [ -z "$PLUGINS_DIR" ]; then
    echo "❌ Error: usage: update-plugin.sh <plugins-dir>"
    exit 1
fi

TMP_DIR=$(mktemp -d)
echo "Using temp dir: $TMP_DIR"
trap 'echo "Restarting plugin loader (trap on exit $?)"; systemctl start plugin_loader.service; rm -rf "$TMP_DIR"' EXIT
ZIP_PATH="$TMP_DIR/bc250-power.zip"

echo -e "\n⏳ Downloading plugin zip file to $ZIP_PATH...\n"
if ! curl -fL -o "$ZIP_PATH" https://github.com/mix3d/bc250-perf-profile-switcher/releases/latest/download/bc250-power.zip; then
    echo "❌ Error: download failed (curl exit $?)"
    exit 1
fi
echo "Downloaded $(du -h "$ZIP_PATH" | cut -f1)"

echo -e "\n⏹ Stopping plugin loader...\n"
systemctl stop plugin_loader.service

echo "Unzipping to $PLUGINS_DIR..."
if ! unzip -o "$ZIP_PATH" -d "$PLUGINS_DIR"; then
    echo "❌ Error: unzip failed (exit $?) — plugin loader will still be restarted by the exit trap"
    exit 1
fi

echo -e "\n✅ Update complete — plugin loader will be restarted by the exit trap"
