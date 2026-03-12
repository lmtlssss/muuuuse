# 🔌Muuuuse

`muuuuse` installs one CLI:

- `muuuuse`

The public brand stays `🔌Muuuuse`. The terminal command stays `muuuuse`.

## What It Is Now

`🔌Muuuuse` no longer expects you to arm a terminal first and launch something later.

The main flow is:

```bash
muuuuse 1 <program...>
muuuuse 2 <program...>
muuuuse stop
```

Seat `1` and seat `2` each launch and own a real local program under a PTY wrapper. Once both seats are alive in the same lane, they automatically bounce final blocks between each other by typing the partner answer plus `Enter` into the wrapped program.

`muuuuse stop` is the real cleanup command. With no flags it force-stops every tracked lane. Use `--session <name>` if you only want one explicit lane.

## Install

```bash
npm install -g muuuuse
```

## Fastest AI Flow

Terminal 1:

```bash
muuuuse 1 codex
```

Terminal 2:

```bash
muuuuse 2 gemini
```

Terminal 3:

```bash
muuuuse stop
```

Known presets expand to recommended flags automatically:

- `codex`
- `claude`
- `gemini`

So `muuuuse 1 codex` launches the fuller Codex command, not just bare `codex`.

## Generic Program Flow

This is not AI-only. Any local program can be wrapped directly.

Example:

```bash
muuuuse 1 bash -lc 'while read line; do printf "left: %s\n\n" "$line"; done'
muuuuse 2 bash -lc 'while read line; do printf "right: %s\n\n" "$line"; done'
```

Type into one seat and the other seat will receive the relayed block.

For Codex, Claude, and Gemini, `🔌Muuuuse` waits for their structured final-answer logs instead of relaying transient screen chatter. For anything else, it first looks for an explicit `(answer)` block and otherwise falls back to the last stable output block after a turn goes idle.

## Sessions

Seats auto-pair by current working directory by default.

If you want an explicit lane name, use:

```bash
muuuuse 1 --session demo codex
muuuuse 2 --session demo gemini
muuuuse stop --session demo
```

You can also inspect the lane:

```bash
muuuuse status
```

## Doctor

```bash
muuuuse doctor
```

This checks the local runtime plus common agent binaries if you use them.

## Notes

- local only
- no tmux requirement for the main path
- no remote control surface here; that belongs to `codeman`
- best with programs that naturally produce turn-shaped output
