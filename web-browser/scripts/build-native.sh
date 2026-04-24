#!/bin/sh
set -eu

exec node "$(dirname -- "$0")/ensure-native.js"
