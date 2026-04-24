---
name: web-browser
description: "Allows interacting with web pages by navigating, evaluating JavaScript, sending raw CDP commands, taking screenshots, picking elements, and dismissing cookie dialogs. When the agent needs to browse the web, it can use this skill to do so."
license: Stolen from Mario
---

# Web Browser Skill

Minimal browser tools for collaborative site exploration. Commands start the
socket-activated browser daemon on demand; do not start Chrome manually.

Install notes are in `README.md`.

## Navigate

```bash
./bin/agent-web open example.com
./bin/agent-web nav https://example.com
./bin/agent-web nav example.com
./bin/agent-web nav https://example.com --new
```

Navigate the caller group's current tab or open a new tab. URLs without a
scheme default to `https://`.

## Snapshot And Actions

```bash
./bin/agent-web snapshot
./bin/agent-web snapshot --role button
./bin/agent-web snapshot --name Submit
./bin/agent-web snapshot --text billing
./bin/agent-web snapshot --role link --name docs
./bin/agent-web snapshot --limit 80
./bin/agent-web click @e2
./bin/agent-web fill @e3 "test@example.com"
./bin/agent-web get text @e1
```

`snapshot` prints an accessibility tree with refs. Refs are scoped to this caller
session. Each snapshot refreshes the live ref map, keeps refs stable for
surviving backend DOM nodes, allocates new refs for new nodes, and drops refs
for nodes that no longer exist. Navigating to a different document, changing
the active page URL, or switching tabs invalidates the previous ref map; take a
new snapshot before using refs on the new page.

Snapshot output can be filtered when pages produce long accessibility trees:

```bash
./bin/agent-web snapshot --interactive
./bin/agent-web snapshot --headings
./bin/agent-web snapshot --links
./bin/agent-web snapshot --forms
```

`--role <role>` matches an exact accessibility role, case-insensitively.
`--name <text>` matches accessible names. `--text <text>` matches the role plus
accessible name. `--limit <n>` limits matched entries before context expansion.

Preset filters are role groups:

- `--interactive`: buttons, links, tabs, menu items, options, and form controls.
- `--headings`: headings.
- `--links`: links.
- `--forms`: buttons and form controls.

Use `--context <n>` with a filter to include matching nodes plus up to `n`
visible ancestor levels and `n` visible descendant levels:

```bash
./bin/agent-web snapshot --name checkout --context 2
```

Use `--within <ref|selector>` to print only the accessibility subtree under an
existing ref or CSS selector:

```bash
./bin/agent-web snapshot --within @e14
./bin/agent-web snapshot --within "#settings-modal"
./bin/agent-web snapshot --within "#settings-modal" --interactive
```

Filtered snapshots still reconcile the full ref map for the caller session
before printing. Printed refs may skip numbers because hidden nodes also keep
their refs, and hidden refs from the same snapshot can still be used by later
`click`, `fill`, `get`, and `find` commands.

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

## Raw CDP

```bash
./bin/agent-web cdp <Domain.method> [json-params]
./bin/agent-web cdp browser <Domain.method> [json-params]
./bin/agent-web cdp target <targetId> <Domain.method> [json-params]
```

Send a raw Chrome DevTools Protocol command. By default, commands run against
this caller session's active tab:

```bash
./bin/agent-web cdp Runtime.evaluate '{"expression":"document.title","returnByValue":true}'
./bin/agent-web cdp Page.getLayoutMetrics
```

Use `browser` for browser-level CDP commands:

```bash
./bin/agent-web cdp browser Browser.getVersion
```

Use `target` to send a command to a specific tab owned by this caller session:

```bash
./bin/agent-web list-tabs
./bin/agent-web cdp target <targetId> Runtime.evaluate '{"expression":"location.href","returnByValue":true}'
```

Pass `-` as the params argument to read JSON from stdin:

```bash
printf '%s\n' '{"expression":"document.body.innerText","returnByValue":true}' \
  | ./bin/agent-web cdp Runtime.evaluate -
```

Output is raw JSON from CDP. Target-scoped commands may only address tabs owned
by this caller session.

## Screenshot

```bash
./bin/agent-web screenshot
./bin/agent-web screenshot page.png
./bin/agent-web screenshot --full-page
```

Takes a screenshot and returns a temp file path.

- Default: current viewport
- `--full-page`: captures full document height

## Tabs

```bash
./bin/agent-web list-tabs
./bin/agent-web close
./bin/agent-web close-session
```

List this caller session's tabs, close the current tab, or close all tabs owned
by this caller session.

## Let The User Pick Elements

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

## Status

```bash
./bin/agent-web status
./bin/agent-web daemon-status
```

Checks that the daemon is working and reports how many tabs this caller session owns.
Use `daemon-status` for detailed daemon diagnostics.
