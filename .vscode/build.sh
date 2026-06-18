#!/usr/bin/env bash
CLI_LOCATION="$(pwd)/cli"
echo "Building plugin in $(pwd)"
printf "Please input sudo password to proceed.\n"

echo $sudopass | sudo -E $CLI_LOCATION/decky plugin build $(pwd)
