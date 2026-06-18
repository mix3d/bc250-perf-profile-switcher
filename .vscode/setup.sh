#!/usr/bin/env bash
PNPM_INSTALLED="$(which pnpm)"
CLI_INSTALLED="$(pwd)/cli/decky"

echo "If you are using alpine linux, do not expect any support."
if [[ "$PNPM_INSTALLED" =~ "which" ]]; then
    echo "pnpm is not currently installed. Install it via your distro's package manager or via the script below."
    read run_pnpm_script
    if [[ "$run_pnpm_script" =~ "n" ]]; then
        echo "Please install pnpm before attempting to build your plugin."
    else
        CURL_INSTALLED="$(which curl)"
        WGET_INSTALLED="$(which wget)"
        if [[ "$CURL_INSTALLED" =~ "which" ]]; then
            printf "curl not found, attempting with wget.\n"
            if [[ "$WGET_INSTALLED" =~ "which" ]]; then
                printf "wget not found, please install wget or curl.\n"
            else
                wget -qO- https://get.pnpm.io/install.sh | sh -
            fi
        else
            curl -fsSL https://get.pnpm.io/install.sh | sh -
        fi
    fi
fi

if ! test -f "$CLI_INSTALLED"; then
    echo "The Decky CLI tool is used to build your plugin as a zip. Hit enter to install it, or type 'no' to skip."
    read run_cli_script
    if [[ "$run_cli_script" =~ "n" ]]; then
        echo "Skipping Decky CLI install."
    else
        SYSTEM_ARCH="$(uname -a)"
        mkdir -p "$(pwd)"/cli
        if [[ "$SYSTEM_ARCH" =~ "x86_64" ]]; then
            if [[ "$SYSTEM_ARCH" =~ "Linux" ]]; then
                curl -L -o "$(pwd)"/cli/decky "https://github.com/SteamDeckHomebrew/cli/releases/latest/download/decky-linux-x86_64"
            fi
            if [[ "$SYSTEM_ARCH" =~ "Darwin" ]]; then
                curl -L -o "$(pwd)"/cli/decky "https://github.com/SteamDeckHomebrew/cli/releases/latest/download/decky-macOS-x86_64"
            fi
        elif [[ "$SYSTEM_ARCH" =~ "arm64" || "$SYSTEM_ARCH" =~ "aarch64" ]]; then
            if [[ "$SYSTEM_ARCH" =~ "Linux" ]]; then
                curl -L -o "$(pwd)"/cli/decky "https://github.com/SteamDeckHomebrew/cli/releases/latest/download/decky-linux-aarch64"
            fi
            if [[ "$SYSTEM_ARCH" =~ "Darwin" ]]; then
                curl -L -o "$(pwd)"/cli/decky "https://github.com/SteamDeckHomebrew/cli/releases/latest/download/decky-macOS-aarch64"
            fi
        else
            echo "Unsupported arch: $SYSTEM_ARCH"
        fi
        chmod +x "$(pwd)"/cli/decky
        echo "Decky CLI installed."
    fi
fi
