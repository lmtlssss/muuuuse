# 🔌Muuuuse

`🔌Muuuuse` is a dead-simple terminal relay.

It does one thing:
- arm two raw terminals
- watch for the final BEL-marked message from whatever program is running inside them
- inject that final message into the other armed terminal
- keep bouncing forever until you stop it

There are only three commands:

```bash
muuuuse 1
muuuuse 2
muuuuse stop
```

No tmux.
No program arguments.
No status command.
No doctor command.
No preset logic.

## Flow

Shell 1:

```bash
muuuuse 1
```

Shell 2:

```bash
muuuuse 2
```

Now both shells are armed. Use them normally.

If you want Codex in one and Gemini in the other, start them inside the armed shells:

```bash
codex
```

```bash
gemini
```

Or run any other program. `🔌Muuuuse` is program-agnostic.

When the running program rings the terminal bell, `🔌Muuuuse` takes the final output block for that turn and injects it into the partner seat.

Stop the whole loop from any other shell:

```bash
muuuuse stop
```

## Install

```bash
npm install -g muuuuse
```

## What Counts As A Relay

`🔌Muuuuse` watches the armed terminal output for BEL (`\u0007`).

That BEL marks the end of a turn.

When it sees BEL, it:
1. grabs the final output block since the last submitted input
2. cleans the block
3. appends it to the seat event log
4. injects it into the other armed terminal followed by Enter

## Notes

- local only
- seat pairing defaults by current working directory
- state lives under `~/.muuuuse`
- `codeman` remains the richer transport layer
- `🔌Muuuuse` is the tiny relay protocol
