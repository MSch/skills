---
name: background-services
description: Create or update small repo-local wrappers for long-running background tasks with a simple `start|restart|stop|status|logs` interface. Use when you should keep background processes isolated, uniquely named, easy to inspect, and journal-backed; prefer transient user services via `systemd-run --user` unless the repo already uses another established pattern.
---

# Background Services

Prefer a tiny wrapper script over ad hoc tmux sessions, `nohup`, or handwritten PID files.
Use stable unit names, stop any prior instance before starting a new one, and read logs from the user journal.
Prefer `bin/serve` as the wrapper name unless the repo already has a clearer established convention.

```bash
#!/bin/bash
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-start}"

UNITS=(
  "myapp-ui:my-command --flag"
)

case "$ACTION" in
  start)
    for entry in "${UNITS[@]}"; do
      name="${entry%%:*}"
      cmd="${entry#*:}"
      systemctl --user stop "$name" 2>/dev/null || true
      systemctl --user reset-failed "$name" 2>/dev/null || true
      systemd-run --user \
        --unit="$name" \
        --working-directory="$PROJECT" \
        --setenv=PATH="$PATH" \
        -- "$cmd"
    done
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  stop)
    for entry in "${UNITS[@]}"; do
      name="${entry%%:*}"
      systemctl --user stop "$name" 2>/dev/null || true
      systemctl --user reset-failed "$name" 2>/dev/null || true
    done
    ;;
  status)
    for entry in "${UNITS[@]}"; do
      name="${entry%%:*}"
      state=$(systemctl --user is-active "$name" 2>/dev/null || true)
      printf "  %-20s %s\n" "$name" "$state"
    done
    ;;
  logs)
    shift
    journalctl --user -u myapp-ui --no-pager "$@"
    ;;
  *)
    echo "Usage: $0 [start|stop|restart|status|logs [-f]]"
    exit 1
    ;;
esac
```

Use transient `.service` units for commands started by systemd.
