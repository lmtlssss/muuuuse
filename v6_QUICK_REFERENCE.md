# Muuuuse v6 Quick Reference - Key Files & Changes

## Files That Need Changes

### 1. `/root/muuuuse/src/util.js` (Smallest changes)
**Status: REMOVE ONLY - 2 functions**

```
Lines 178-180: DELETE isAnchorSeat()
Lines 182-188: DELETE getPartnerSeatId()
Lines 328, 330: DELETE exports of above
```

**Why**: These hardcoded odd/even logic. v6 needs arbitrary seat-to-seat links.

---

### 2. `/root/muuuuse/src/cli.js` (Medium changes)
**Status: REWRITE parsing, update display**

**DELETE:**
- Lines 87-95: `renderLinkTargets()` (can simplify or rewrite)
- Lines 156-244: `parseLinkTargets()` (complete rewrite)
- Line 215: Call to `getPartnerSeatId()`

**REWRITE:**
- Lines 59: `parseSeatOptions()` - remove `continueSeatId`, use `relayTargets`
- Lines 74-106: `renderSeatStatus()` - show all targets, not just partner
- Line 60-66: `main()` - pass `relayTargets` to ArmedSeat

**ADD:**
- New `parseLinkTargets()` that creates array of `{ targetSeatId, flowMode }`

**Why**: Old parser treated partner specially and "continue" targets differently. v6 treats all targets uniformly with per-target flow modes.

---

### 3. `/root/muuuuse/src/runtime.js` (Largest changes)
**Status: REMOVE anchor/partner logic, add multi-target logic**

**DELETE:**
- Lines 145-195: `findJoinableSessionName()` (not needed)
- Lines 197-208: `waitForJoinableSessionName()` (not needed)
- Lines 210-216: `resolveSessionName()` (replace)
- Lines 697-716: `initializeTrustMaterial()` - anchor-specific version
- Lines 718-855: `syncTrustState()`, `syncSeatOneTrust()`, `syncSeatTwoTrust()`
- Lines 857-861: `isPaired()`
- Lines 1017-1020: `partnerIsLive()`
- Lines 1071-1136: `pullPartnerEvents()`
- All references to `getPartnerSeatId()`, `isAnchorSeat()`
- Properties from ArmedSeat constructor:
  - `this.partnerSeatId`
  - `this.anchorSeatId`
  - `this.continueSeatId`
  - `this.continueTargets`
  - `this.partnerPaths`
  - `this.partnerOffset`
  - `this.trustState` (single object with challenge/phase/peerPublicKey)

**ADD:**
- `createOrJoinSessionName(cwd, seatId)` - let any seat create or join
- `findExistingSession(cwd, seatId)` - helper for above
- ArmedSeat properties:
  - `this.relayTargets` = array of `{ targetSeatId, flowMode }`
  - `this.relayTargetPaths` = map: targetSeatId → paths
  - `this.targetOffsets` = map: targetSeatId → file offset
  - `this.targetKeys` = map: targetSeatId → public key
  - `this.targetChallenges` = map: targetSeatId → challenge
- New methods in ArmedSeat:
  - `initializeTrustMaterial()` - symmetric (not anchor-specific)
  - `syncMultiTargetTrust()` - sync with all relay targets
  - `syncTargetTrust(targetSeatId)` - per-target pairing
  - `initiateTargetPairing(targetSeatId)` - write challenge
  - `respondToTargetPairing(targetSeatId, challenge)` - write signature
  - `pullInboundRelays()` - read from all targets' events

**MODIFY:**
- ArmedSeat constructor: use `relayTargets`, call `createOrJoinSessionName()`
- `launchShell()`: call `syncMultiTargetTrust()`
- `emitAnswer()`: sign for EACH target with THAT target's challenge
- `tick()`: call `pullInboundRelays()` instead of `pullPartnerEvents()`
- `writeMeta()`, `writeStatus()`, `writeController()`: update to use relayTargets
- `forwardContinuation()`: keep or remove (backward compat)

**Why**: The entire trust flow needs to be symmetric (any two peers can pair) and support N targets instead of 1 partner.

---

### 4. `/root/muuuuse/src/agents.js`
**Status: NO CHANGES** - This handles agent detection (Claude, Codex, Gemini)

---

### 5. `/root/muuuuse/package.json`
**Status: TRIVIAL**
- Line 3: version → "6.0.0"
- Line 4: description → mention free-form relay

---

### 6. `/root/muuuuse/README.md`
**Status: UPDATE EXAMPLES**
- Old: `muuuuse 1 flow on`, `muuuuse 2 flow off`
- New: `muuuuse 1 link 2 flow on 3 flow off`
- Remove odd/even pairing explanation
- Add example of arbitrary topologies

---

## Command Syntax Change

### OLD (v5)
```bash
# Odd seat creates session
muuuuse 1 flow on

# Even seat joins
muuuuse 2 flow off

# Additional pairs
muuuuse 3 flow on
muuuuse 4 flow off

# Forwarding
muuuuse 4 continue 1  # Routes 4 output to 1, but keeps odd/even pairing
```

### NEW (v6)
```bash
# Seat 1 relays to seat 2 (flow on) and seat 3 (flow off)
muuuuse 1 link 2 flow on 3 flow off

# Seat 2 relays to seat 1 and 4
muuuuse 2 link 1 flow off 4 flow off

# Seat 3 relays to seat 1
muuuuse 3 link 1 flow on

# Seat 4 relays to seats 2 and 3
muuuuse 4 link 2 flow on 3 flow on

# No need to start seats in any particular order
muuuuse status   # See all linked seats
muuuuse stop     # Stop all
```

---

## Trust Model Change

### OLD (v5)
- Odd seat (1, 3, 5...) generates challenge
- Even seat (2, 4, 6...) signs challenge
- Pair is implicit in seat IDs
- Only one peer per seat
- Files: `challenge.json`, `claim.json`, `ack.json`

### NEW (v6)
- Any seat can initiate with any other seat
- Initiator writes `initiator_challenge.json`
- Responder writes `responder_signature.json`
- Multiple independent pairings per seat (one per relay target)
- Per-target files: `seat-{seatId}/{targetSeatId}/initiator_challenge.json`, etc.
- Per-target tracking: `this.targetKeys[targetSeatId]`, `this.targetChallenges[targetSeatId]`

---

## Relay Flow Change

### OLD (v5)
```
Seat 1 (flow on)
  ↓ reads single partner's events
Seat 2 (flow off)
  ↓ relays back to partner
Seat 1
```

### NEW (v6)
```
Seat 1 (link 2 flow on, 3 flow off)
  ↓ reads events from Seat 2 (flow on) and Seat 3 (flow off)
Seat 2 / Seat 3 (any other seat)
  ↓ can have their own relay targets
Seat 4, Seat 5, ...
```

- Each seat has N relay targets (not just 1 partner)
- Each target has its own flow mode
- Each target has its own challenge/signature pair
- Answer signed once per target

---

## Directory Structure (Sessions)

```
~/.muuuuse/sessions/{sessionName}/
├── controller.json
├── seat-1/
│   ├── id_ed25519          (unchanged)
│   ├── meta.json           (changed: relayTargets)
│   ├── status.json         (changed: relayTargets)
│   ├── events.jsonl        (unchanged)
│   └── (optional) target-2/
│       ├── initiator_challenge.json    (if seat 1 initiated with 2)
│       └── responder_signature.json    (if seat 1 responding to 2)
├── seat-2/
│   ├── id_ed25519
│   ├── meta.json           (changed)
│   ├── events.jsonl
│   └── target-1/
│       ├── initiator_challenge.json    (if seat 2 initiated with 1)
│       └── responder_signature.json    (if seat 2 responding to 1)
└── seat-3/
    └── ...
```

**Note**: Could also flatten as `seat-1/challenge-with-2.json` or keep in session root. Current design uses per-target subdirs for clarity.

---

## Implementation Checklist

- [ ] Remove `getPartnerSeatId()` and `isAnchorSeat()` from util.js
- [ ] Update util.js exports
- [ ] Add `createOrJoinSessionName()` to runtime.js
- [ ] Update ArmedSeat constructor to use `relayTargets`
- [ ] Replace trust management with per-target sync methods
- [ ] Rewrite `pullPartnerEvents()` → `pullInboundRelays()`
- [ ] Update `emitAnswer()` to sign for each target
- [ ] Rewrite `parseLinkTargets()` in cli.js
- [ ] Update `parseSeatOptions()` in cli.js
- [ ] Update status rendering
- [ ] Update package.json version and description
- [ ] Update README.md with new command syntax
- [ ] Test seat creation/joining
- [ ] Test multi-target relays
- [ ] Test per-target flow modes
- [ ] Test relay chains (1→2→3)
- [ ] Test fan-out (1→2, 1→3, 1→4)
- [ ] Verify backward compat where applicable

---

## Key Design Principles

1. **No Implicit Pairing**: Every relay is explicit in the command
2. **Symmetric Trust**: Any two seats can pair regardless of ID
3. **Independent Targets**: Each relay path has its own flow mode + signature
4. **Session Agnostic**: Sessions are just containers; seats find each other by cwd + seatId
5. **Simple Syntax**: `muuuuse <seatId> link <target1> flow <mode1> [<target2> flow <mode2> ...]`

