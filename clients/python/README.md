# Python Client

This directory contains the publishable Python CLI package for the AIVane Android REPL beta.

## Run

After installation, use the console script:

```bash
agent-android --help
agent-android --repl --url http://<device-ip>:8080
agent-android --health --url http://<device-ip>:8080
```

If the phone requires a shared token:

```bash
agent-android --repl --url http://<device-ip>:8080 --token YOUR_TOKEN
```

Set the environment variable `AIVANE_API_TOKEN` when you prefer not to pass the token on every command line.

Inside the REPL you can also persist it locally:

```text
set token YOUR_TOKEN
```

For prepared multi-step flows:

```bash
agent-android --template template.json --url http://<device-ip>:8080
agent-android --template template.json --async --url http://<device-ip>:8080
```

For a workflow bundle with one main template plus child templates:

```bash
agent-android --application-bundle app.zip --main-template-file __main__.json --url http://<device-ip>:8080
agent-android --application-bundle app.zip --main-template-file __main__.json --async --url http://<device-ip>:8080
```

Async execution returns a `taskId` immediately. Poll or stop the task with:

```bash
agent-android --task TASK_ID --url http://<device-ip>:8080
agent-android --task-logs TASK_ID --url http://<device-ip>:8080
agent-android --stop-task TASK_ID --url http://<device-ip>:8080
```

For syncing templates, images, or other files from your computer to the phone:

```bash
agent-android --upload foo.json --remote-path Templates/foo.json --url http://<device-ip>:8080
agent-android --upload foo.json --remote-path Templates/foo.json --no-overwrite --url http://<device-ip>:8080
```

`--upload` overwrites by default. It uses the same phone-side token check as the other protected REPL endpoints.

## App launch and dual apps

App launch requires a phone-side AIVane build with structured chooser handling.
The CLI waits up to 8 seconds by default (configurable with `--launch-timeout 1..30`).
Known system choosers return immediately with `status: selection_required` and the visible choices.
Exit codes are `0` for a verified foreground app, `2` for selection required, and `1` for failure.
Use `--raw` for a JSON result. A template operation that returned a chooser has `launched: false`;
it must not be treated as a successful app launch.

```bash
agent-android --url http://<device-ip>:8080 --launch com.xingin.xhs --raw
agent-android --url http://<device-ip>:8080 --launch com.xingin.xhs --launch-choice 2
agent-android --url http://<device-ip>:8080 --launch com.xingin.xhs --launch-choice-text "Exact option label"
```

Read the returned choices before choosing. Indices are one-based positions in the current visible
chooser, not persistent Android user IDs or guaranteed original/clone identities. Duplicate labels
require an index. The default-selection checkbox is never changed. An explicit choice requires an
actual chooser selection; merely finding the same package in the foreground is insufficient.
Unknown dialogs time out and can then be inspected with `--list` or `--ui-tree`.

In the REPL, use `la PACKAGE --choice 2` or `la PACKAGE --choice-text "Exact option label"`;
`--timeout SECONDS` sets the total launch wait budget. A chooser result releases control so the next
command can inspect or select it. Only one launch request and at most one selection click are issued.

## Package Layout

- `pyproject.toml`: setuptools package metadata and console-script registration
- `src/agent_android/`: installable package source
- `tests/`: unit and device smoke tests

## Notes

- The package uses a standard `src` layout under `src/agent_android`.
- The phone hosts the beta HTTP service locally and the client connects directly to `http://<device-ip>:8080` by default. If the phone-side REPL settings use a different port, pass that port in `--url`.
- If a command cannot connect, first check whether the AIVane app or its local API service has exited on the phone, then retry `/health`.


