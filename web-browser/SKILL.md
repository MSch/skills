---
name: web-browser
description: "Allows interacting with web pages by navigating, evaluating JavaScript, taking screenshots, picking elements, and dismissing cookie dialogs. When the agent needs to browse the web, it can use this skill to do so."
license: Stolen from Mario
---

# Web Browser Skill

Minimal browser tools for collaborative site exploration. Commands start the
socket-activated browser daemon on demand; do not start Chrome manually.

## One-Time Setup

```bash
systemctl --user link "$PWD/systemd/agent-web-browser.socket" "$PWD/systemd/agent-web-browser.service"
systemctl --user enable --now agent-web-browser.socket
```

The daemon starts one headful Chrome instance lazily and uses an isolated
profile at `~/.cache/agent-web/profile`.

Chrome's internal CDP endpoint defaults to `127.0.0.1:19339`.

## Navigate

```bash
./bin/agent-web open example.com
./bin/agent-web nav https://example.com
./bin/agent-web nav example.com
./bin/agent-web nav https://example.com --new
```

Navigate the caller group's current tab or open a new tab. URLs without a
scheme default to `https://`.

## Status

```bash
./bin/agent-web status
./bin/agent-web daemon-status
./bin/agent-web list-tabs
```

Checks that the daemon is working and reports how many tabs this caller session owns.
Use `daemon-status` for detailed daemon diagnostics.
Use `list-tabs` to list only this caller session's tabs.

## Snapshot And Actions

```bash
./bin/agent-web snapshot
./bin/agent-web click @e2
./bin/agent-web fill @e3 "test@example.com"
./bin/agent-web get text @e1
```

`snapshot` prints an accessibility tree with refs. Refs are scoped to this caller
session and are refreshed each time `snapshot` runs.

Selectors are also supported:

```bash
./bin/agent-web click "#submit"
./bin/agent-web fill "#email" "test@example.com"
./bin/agent-web get value "#email"
./bin/agent-web find role button click --name "Submit"
```

## Evaluate JavaScript

```bash
./bin/agent-web eval 'document.title'
./bin/agent-web eval 'document.querySelectorAll("a").length'
./bin/agent-web eval 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(link => !link.href.startsWith("https://")))'
```

Execute JavaScript in active tab (async context). Be careful with string escaping, best to use single quotes.

## Screenshot

```bash
./bin/agent-web screenshot
./bin/agent-web screenshot page.png
./bin/agent-web screenshot --full-page
```

Takes a screenshot and returns a temp file path.

- Default: current viewport
- `--full-page`: captures full document height

## Close

```bash
./bin/agent-web close
```

Closes this caller session's current tab.

## Pick Elements

```bash
./bin/agent-web pick "Click the submit button"
```

Interactive element picker. Click to select, Cmd/Ctrl+Click for multi-select, Enter to finish.

## Dismiss Cookie Dialogs

```bash
./bin/agent-web dismiss-cookies          # Accept cookies
./bin/agent-web dismiss-cookies --reject # Reject cookies (where possible)
```

Automatically dismisses EU cookie consent dialogs.

Run after navigating to a page:
```bash
./bin/agent-web nav https://example.com && ./bin/agent-web dismiss-cookies
```
