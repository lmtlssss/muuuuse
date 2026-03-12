# 🔌Muuuuse

`🔌Muuuuse` is a tiny no-tmux terminal relay.

It does one job:
- arm terminal one with `muuuuse 1`
- arm terminal two with `muuuuse 2`
- have seat 1 generate a session key and seat 2 sign it
- watch Codex, Claude, or Gemini for real final answers
- inject that final answer into the other armed terminal
- keep looping until you stop it

The whole surface is:

```bash
muuuuse 1
muuuuse 2
muuuuse status
muuuuse stop
```

## Flow

Terminal 1:

```bash
muuuuse 1
```

Terminal 2:

```bash
muuuuse 2
```

Now both shells are armed. `muuuuse 1` generates the session key, `muuuuse 2` signs it, and only that signed pair relays. Use those shells normally.

If you want Codex in one and Gemini in the other, start them inside the armed shells:

```bash
codex
```

```bash
gemini
```

`🔌Muuuuse` tails the local session logs for supported CLIs, detects the final answer, types that answer into the other seat, and then sends Enter as a separate keystroke.

Check the live state from any terminal:

```bash
muuuuse status
```

Stop the loop from any terminal, including one of the armed shells once it is back at a prompt:

```bash
muuuuse stop
```

## Notes

- no tmux
- state lives under `~/.muuuuse`
- only the signed armed pair can exchange relay events
- supported final-answer detection is built for Codex, Claude, and Gemini
- `codeman` remains the larger transport/control layer; `muuuuse` stays local and minimal

## Install

```bash
npm install -g muuuuse
```
