# 🔌Muuuuse

`muuuuse` installs one CLI name:

- `muuuuse`

The visible product brand is always `🔌Muuuuse`, while the terminal command examples use `muuuuse`.

## What It Does

`🔌Muuuuse` is the small local-only relay for three tmux terminals:

- seat `1` listens in one terminal
- seat `2` listens in another terminal
- seat `3` is the controller that auto-pairs them

Once seats `1` and `2` are armed, you can launch Codex, Claude, Gemini, or a deterministic script inside those two terminals. `muuuuse 3` then relays only final answers between them by injecting text plus `Enter` into the opposite seat.

Remote control is intentionally out of scope here. Use `codeman` or `codemansbot` for remote routing.

## Install

```bash
npm install -g muuuuse
```

## Basic Flow

Terminal 1:

```bash
muuuuse 1
codex -m gpt-5.4 -c model_reasoning_effort=low --dangerously-bypass-approvals-and-sandbox --no-alt-screen
```

Terminal 2:

```bash
muuuuse 2
claude --dangerously-skip-permissions --permission-mode bypassPermissions
```

Terminal 3:

```bash
muuuuse 3 "Start by proposing the first concrete repo task."
```

That third command auto-pairs seats `1` and `2`, then optionally drops a one-time kickoff prompt into seat `1`.

## Preset Launches

`🔌Muuuuse` does not launch the CLIs for you anymore. It arms the terminal, watches the live process, and reads only final answers from the local transcript files.

Recommended god-mode launches:

```bash
codex -m gpt-5.4 -c model_reasoning_effort=low --dangerously-bypass-approvals-and-sandbox --no-alt-screen
claude --dangerously-skip-permissions --permission-mode bypassPermissions
gemini --approval-mode yolo --sandbox=false
```

## Script Mode

Turn an armed seat into a deterministic responder:

```bash
muuuuse script
```

That stores one repeating response.

For a loop of multiple steps:

```bash
muuuuse script 4
```

That collects four prompts and cycles them forever, one per inbound turn.

To leave script mode and go back to a live CLI listener:

```bash
muuuuse live
```

## Requirements

- `tmux`
- `git`
- `npm`
- at least one local CLI you want to mirror: `codex`, `claude`, `gemini`, or script mode

## Doctor

```bash
muuuuse doctor
```

This checks:

- `git`
- `npm`
- `tmux`
- `codex`
- `claude`
- `gemini`
- `/root/npm.txt` or the fallback npm token path

## Notes

- local only
- auto-pair, no auth key ceremony
- only final answers are forwarded
- no verbose stream forwarding
- no reasoning forwarding
- controller exit stops the relay
