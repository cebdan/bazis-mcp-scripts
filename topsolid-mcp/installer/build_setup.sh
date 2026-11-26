#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
cargo xwin build --release --target x86_64-pc-windows-msvc
cp "target/x86_64-pc-windows-msvc/release/topsolid6-mcp-setup.exe" "../TopSolid_MCP_Setup.exe"
rm -f "../TopSolid6_MCP_Setup.exe"
ls -lh "../TopSolid_MCP_Setup.exe"
