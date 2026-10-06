#!/usr/bin/env bash

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$ROOT_DIR/.local/rgb-lightning-node"

echo "=== AIR-GB Lightning setup ==="

# Check dependencies
for cmd in git cargo docker; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing dependency: $cmd"
        exit 1
    fi
done

# Clone RGB Lightning Node
if [ ! -d "$INSTALL_DIR" ]; then
    echo "Cloning RGB Lightning Node..."

    mkdir -p "$ROOT_DIR/.local"

    git clone \
        https://github.com/RGB-Tools/rgb-lightning-node \
        --recurse-submodules \
        --shallow-submodules \
        "$INSTALL_DIR"
else
    echo "RGB Lightning Node already cloned."
fi

# Install binary
echo "Installing RGB Lightning Node..."

cd "$INSTALL_DIR"

cargo install --locked --path .

echo
echo "Installation completed."
echo
echo "Check with:"
echo "  rgb-lightning-node --help"
echo
echo "Start local regtest infrastructure with:"
echo "  cd $INSTALL_DIR"
echo "  ./regtest.sh start"
