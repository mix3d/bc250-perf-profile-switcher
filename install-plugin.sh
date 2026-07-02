# Check if the script was run with sudo
if [ -z "$SUDO_USER" ]; then
    echo "❌ Error: This script must be run with sudo!"
    echo "Please try again using: sudo ./install-plugin.sh"
    exit 1
fi

# Download the plugin zip file to a temp directory, regardless of where the script is run from
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
ZIP_PATH="$TMP_DIR/bc250-power.zip"

echo -e "\n⏳ Downloading plugin zip file...\n"
curl -L -o "$ZIP_PATH" https://github.com/mix3d/bc250-perf-profile-switcher/releases/latest/download/bc250-power.zip

echo -e "❌ Stopping plugin loader...\n"
systemctl stop plugin_loader.service

#unzip correctly regardless of the script being sudo'd or not
unzip -o "$ZIP_PATH" -d /home/$SUDO_USER/homebrew/plugins/

systemctl start plugin_loader.service
echo -e "\n✅ Plugin loader restarted"

echo -e "\n\U0001F5D1  Zip file deleted"
