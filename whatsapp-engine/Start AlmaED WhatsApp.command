#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then open this file again."
  open https://nodejs.org
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
node src/index.js
echo
read -n 1 -s -r -p "The engine has stopped. Press any key to close."
