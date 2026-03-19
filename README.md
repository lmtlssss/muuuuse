# 🔌Muuuuse

`🔌Muuuuse` is a tiny terminal relay.

It does one job:
- arm terminal one with `muuuuse 1`
- arm terminal two with `muuuuse 2`
- let each seat define signed relay links to any other armed seat
- choose per-seat relay mode with `flow on` or `flow off`
- watch Codex, Claude, or Gemini for local assistant output
- inject that output into linked armed terminals
- keep looping until you stop it

The whole surface is:

```bash
muuuuse 1
muuuuse 1 flow on
muuuuse 1 flow off
muuuuse 1 flow off continue 5
muuuuse 1 link 2 flow on 3 flow off 5 flow off
muuuuse 2
muuuuse 2 flow off
muuuuse 2 flow on continue 3
muuuuse 2 link 1 flow off 3 flow on 4 flow on
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
muuuuse 1 link 2 flow on
```

Terminal 2:

```bash
muuuuse 2 link 1 flow off link 3 flow on link 4 flow on
```

Now both shells are armed in the same cwd and join the same relay graph. Every seat has its own Ed25519 keypair. Each forwarded relay is signed by the sending seat. A target seat only accepts inbound relays from seats it links back to, so the graph can be open-ended without becoming an all-to-all broadcast.

`link <seat> flow on` means that outbound edge sends commentary and final answers. `link <seat> flow off` means that outbound edge sends final answers only. This is sender-side routing, not receiver-side filtering.

`continue <seat>` is shorthand for one outbound link that uses the seat's default `flow on|off`. Explicit `link ... flow ...` edges are the full model and can be arranged into loops such as `1 -> 2 -> 3 -> 4 -> 1`.

If you want Codex in one and Gemini in the other, start them inside the armed shells:

```bash
codex
```

```bash
gemini
```

`🔌Muuuuse` tails the local session logs for supported CLIs, relays according to each outbound link's flow mode, types that output into the target seat, and then sends Enter as a separate keystroke.

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
- all armed seats in the same cwd share one relay session graph
- only signed relays from reciprocally linked seats are accepted
- `continue <seat>` is a convenience alias for a single signed outbound link
- supported relay detection is built for Codex, Claude, and Gemini

## Install

```bash
npm install -g muuuuse
```
