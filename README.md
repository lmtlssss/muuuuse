# 🔌Muuuuse

`🔌Muuuuse` is a tiny terminal relay.

It does one job:
- arm terminal one with `muuuuse 1`
- arm terminal two with `muuuuse 2`
- have seat 1 generate a session key and seat 2 sign it
- additional isolated pairs work the same way: `3/4`, `5/6`, `7/8`, ...
- choose per-seat relay mode with `flow on` or `flow off`
- watch Codex, Claude, or Gemini for local assistant output
- inject that output into the other armed terminal
- keep looping until you stop it

The whole surface is:

```bash
muuuuse 1
muuuuse 1 flow on
muuuuse 1 flow off
muuuuse 1 flow off continue 5
muuuuse 2
muuuuse 2 flow off
muuuuse 2 flow on continue 3
muuuuse 3
muuuuse 3 flow on
muuuuse 4
muuuuse 4 flow off continue 1
muuuuse status
muuuuse stop
```

## Flow

Terminal 1:

```bash
muuuuse 1 flow on
```

Terminal 2:

```bash
muuuuse 2 flow off
```

Now both shells are armed. `muuuuse 1` generates the session key, `muuuuse 2` signs it, and only that signed pair relays. Every odd/even adjacent pair works the same way in parallel: `3/4`, `5/6`, `7/8`, and so on. Use those shells normally.

`flow on` means that seat relays commentary and final answers. `flow off` means that seat relays and accepts final answers only. Mixed calibration is allowed per seat.

`continue <seat>` forwards that seat's relayed output into another armed seat without changing the signed odd/even pair law. This lets you build local loops like `1 -> 2 -> 3 -> 4 -> 1` while every adjacent pair still keeps its own session keypair.

If you want Codex in one and Gemini in the other, start them inside the armed shells:

```bash
codex
```

```bash
gemini
```

`🔌Muuuuse` tails the local session logs for supported CLIs, relays according to each seat's flow mode, types that output into the other seat, and then sends Enter as a separate keystroke.

Check the live state from any terminal:

```bash
muuuuse status
```

Stop the loop from any terminal, including one of the armed shells once it is back at a prompt:

```bash
muuuuse stop
```

## Notes

- state lives under `~/.muuuuse`
- only the signed armed pair can exchange relay events
- `continue <seat>` is a separate local forwarding lane and can target any armed seat number
- supported relay detection is built for Codex, Claude, and Gemini

## Install

```bash
npm install -g muuuuse
```
