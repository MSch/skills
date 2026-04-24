# Web Browser Skill

## Install

Requires `google-chrome-stable`, `google-chrome`, `chromium`, or
`chromium-browser` in `PATH`.

From this directory:

```bash
systemctl --user link "$PWD/systemd/agent-web-browser.socket" "$PWD/systemd/agent-web-browser.service"
systemctl --user enable --now agent-web-browser.socket
```

Verify:

```bash
./bin/agent-web daemon-status
```
