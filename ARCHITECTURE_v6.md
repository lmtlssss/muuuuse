# 🔌Muuuuse v6 Architecture Design

## Overview

Muuuuse v6 removes the odd/even pairing constraint entirely. Instead, it implements a free-form relay model where:
- **Any seat can initiate relay to any other seat independently**
- **No anchor seat generation** - any seat can initiate cryptographic pairing
- **Per-target flow modes** - each relay connection has its own flow mode setting
- **Simple command syntax**: `muuuuse <seatId> link <targetSeatId> flow on [<targetSeatId> flow off ...]`

## Key Architectural Changes Required

### 1. **util.js** - Remove Pairing Functions

**REMOVE:**
- `getPartnerSeatId(seatId)` (line 182-188) - Returns computed even/odd partner
- `isAnchorSeat(seatId)` (line 178-180) - Checks if seat ID is odd

**IMPACT:**
- Functions are used in: runtime.js (15+ locations), cli.js (4 locations)
- All downstream logic needs refactoring to support arbitrary pairing

**NOTES:**
- These functions hardcode odd/even logic: `seatId % 2 === 1` and `seatId + 1`
- No longer needed since any seat can link to any other seat

---

### 2. **runtime.js** - Major Restructuring

#### 2.1 Remove Session Name Generation Based on Anchor Seat

**REMOVE:**
- `findJoinableSessionName()` (line 145-195) - Searches for existing odd seat session
- `waitForJoinableSessionName()` (line 197-208) - Waits for odd seat to start first
- `resolveSessionName()` (line 210-216) - Logic: even seats wait for odd, odd seats create
- Partner-wait logic in `ArmedSeat` constructor (line 596-601)

**REPLACE WITH:**
- `createOrJoinSessionName()` - Each seat can independently create a new session or join an existing one based on seatId+cwd combination
- Session discovery: Look for any session with same cwd that has seats ready to relay (not just anchor/partner pairs)
- Sessions are identified by seatId+sessionName combo, not anchor/partner relationship

**IMPACT:**
- Removes the constraint that even seats must wait for odd seats
- Multiple independent relay chains can coexist in the same session

---

#### 2.2 Remove Trust State Based on Anchor/Partner Roles

**CURRENT TRUST FLOW:**
- Line 627: Anchor seat phase = "waiting_for_peer_signature"
- Line 627: Non-anchor phase = "waiting_for_anchor_key"
- Lines 731-796: `syncSeatOneTrust()` - Anchor generates challenge, waits for partner signature
- Lines 798-855: `syncSeatTwoTrust()` - Partner signs anchor challenge

**REMOVE:**
- Role-based trust setup (anchor vs non-anchor)
- Fixed challenge generation and signature verification tied to seat parity

**REPLACE WITH:**
- **Symmetric peer discovery**: Any two seats can establish trust together
- **Initiator/Responder model**: First seat to write trust material is initiator, second is responder
- New trust flow:
  1. Seat A creates challenge and stores it in its seat directory
  2. Seat B detects challenge in Seat A's directory
  3. Seat B signs the challenge and stores signature in its seat directory
  4. Seat A verifies signature from Seat B
  5. Both seats now trust each other and can exchange relays

**NEW TRUST FILES:**
- `initiator_challenge.json` - Challenge created by initiating seat
- `responder_signature.json` - Signature from responding seat
- Both seats store both keys independently (no shared state)

---

#### 2.3 Refactor ArmedSeat Constructor

**CURRENT (lines 585-641):**
```javascript
constructor(options) {
  this.seatId = options.seatId;
  this.partnerSeatId = getPartnerSeatId(options.seatId);  // REMOVE
  this.anchorSeatId = isAnchorSeat(options.seatId) ? ... // REMOVE
  this.continueSeatId = normalizeContinueSeatId(...);    // KEEP but rename
  this.continueTargets = Array.isArray(...) ? ... : [];   // KEEP - this is the new model

  this.sessionName = resolveSessionName(...);  // CHANGE to createOrJoinSessionName()
  if (!this.sessionName) {
    throw new Error(`No armed muuuuse ${this.partnerSeatId}...`);  // CHANGE error message
  }
  this.partnerPaths = getSeatPaths(..., this.partnerSeatId);  // REMOVE
}
```

**CHANGE TO:**
```javascript
constructor(options) {
  this.seatId = options.seatId;
  this.relayTargets = Array.isArray(options.relayTargets) ? options.relayTargets : [];
  // Format: [{ targetSeatId: 2, flowMode: "on" }, { targetSeatId: 3, flowMode: "off" }]

  this.cwd = normalizeWorkingPath(options.cwd);
  this.sessionName = createOrJoinSessionName(this.cwd, this.seatId);  // NEW

  if (!this.sessionName) {
    throw new Error(`Failed to create session for seat ${this.seatId}`);
  }

  this.sessionPaths = getSessionPaths(this.sessionName);
  this.paths = getSeatPaths(this.sessionName, this.seatId);
  this.relayTargetPaths = {};  // Maps targetSeatId -> paths
  for (const target of this.relayTargets) {
    this.relayTargetPaths[target.targetSeatId] = getSeatPaths(this.sessionName, target.targetSeatId);
  }
}
```

---

#### 2.4 Refactor Relay Logic for Multiple Targets

**CURRENT FLOW (single partner):**
- Line 1071: `pullPartnerEvents()` - reads from one partner's events
- Line 1134: Logs only partner ID
- Line 1074: Checks single `this.isPaired()` condition

**NEW FLOW (multiple targets with per-target flow modes):**
```javascript
async pullInboundRelays() {
  // Pull from ALL configured relay targets, not just one partner
  for (const target of this.relayTargets) {
    const targetPaths = this.relayTargetPaths[target.targetSeatId];
    const { nextOffset, text } = readAppendedText(targetPaths.eventsPath, this.targetOffsets[target.targetSeatId]);
    this.targetOffsets[target.targetSeatId] = nextOffset;

    const entries = parseAnswerEntries(text);
    for (const entry of entries) {
      // Use target.flowMode instead of this.flowMode
      if (!shouldAcceptInboundEntry(target.flowMode, entry)) {
        continue;
      }

      // Verify signature using target's public key
      if (!verifyWithTargetKey(entry, target.targetSeatId)) {
        continue;
      }

      const delivered = await sendTextAndEnter(this.child, entry.text, ...);
      this.relayCount += 1;
      this.log(`[${target.targetSeatId} -> ${this.seatId}] ${previewText(entry.text)}`);
    }
  }
}
```

**IMPACT:**
- Remove `partnerOffset` and `partnerPaths`
- Add `relayTargets` array with per-target flow modes
- Add `targetOffsets` map to track each target's events position
- Add `targetKeys` map to store each target's public key for signature verification

---

#### 2.5 Refactor Relay Target Discovery and Pairing

**REMOVE:**
- Line 1017: `partnerIsLive()` - checks single partner
- Assumption that there's only one peer to verify against

**REPLACE WITH:**
```javascript
getRelayTargetInfo(targetSeatId) {
  // Load the target seat's public key and challenge from its seat directory
  const targetPaths = getSeatPaths(this.sessionName, targetSeatId);
  const targetInitiator = readJson(targetPaths.initiatorChallengeFile, null);
  const targetResponder = readJson(targetPaths.responderSignatureFile, null);

  // Return whichever is available (depending on which side of pairing we are)
  return { targetInitiator, targetResponder };
}

isRelayTargetReady(targetSeatId) {
  // Target is ready if both sides have written their trust materials
  const info = this.getRelayTargetInfo(targetSeatId);
  return Boolean(info.targetInitiator && info.targetResponder);
}

syncMultiTargetTrust() {
  // For each relay target, ensure we've exchanged keys
  for (const target of this.relayTargets) {
    if (!this.targetKeys[target.targetSeatId]) {
      const info = this.getRelayTargetInfo(target.targetSeatId);
      if (info.targetResponder?.publicKey) {
        this.targetKeys[target.targetSeatId] = info.targetResponder.publicKey;
      }
    }
  }
}
```

---

#### 2.6 Refactor Event Emission to Support Multiple Relays

**CURRENT (line 1414-1461):**
```javascript
emitAnswer(entry) {
  const signedEntry = {
    id: ...,
    challenge: this.trustState.challenge,  // SINGLE challenge
    publicKey: this.identity.publicKey,
    signature: signText(..., this.trustState.challenge, ...)
  };
  appendJsonl(this.paths.eventsPath, signedEntry);
  this.forwardContinuation(signedEntry);  // OLD continue model
}
```

**NEW:**
```javascript
emitAnswer(entry) {
  // Create one signed entry for each relay target with that target's challenge
  for (const target of this.relayTargets) {
    const targetChallenge = this.targetChallenges[target.targetSeatId];
    if (!targetChallenge) {
      continue;  // Skip targets we haven't paired with yet
    }

    const signedEntry = {
      id: entry.id,
      challenge: targetChallenge,  // PER-TARGET challenge
      publicKey: this.identity.publicKey,
      text: entry.text,
      // ... other fields
    };

    signedEntry.signature = signText(
      buildAnswerSignaturePayload(this.sessionName, targetChallenge, signedEntry),
      this.identity.privateKey
    );

    // Store in target's event log
    const targetPaths = this.relayTargetPaths[target.targetSeatId];
    appendJsonl(targetPaths.eventsPath, signedEntry);
  }
}
```

**IMPACT:**
- One answer gets signed with each target's challenge
- Each target gets the answer in their own events log
- Allows independent trust establishment per target

---

### 3. **cli.js** - Update Command Parsing

**CURRENT (line 156-244):**
```javascript
// parseLinkTargets() function
const partnerSeatId = seatId ? getPartnerSeatId(seatId) : null;
// Special handling of partner vs continue targets
if (targetSeatId === partnerSeatId) {
  flowMode = targetFlowMode;  // Partner gets its own flowMode
} else {
  continueTargets.push(...);  // Others are "continue" targets
}
```

**REMOVE:**
- Partner special case handling
- Distinction between "partner" and "continue" targets

**REPLACE WITH:**
- All targets are now just `relayTargets` with per-target flow modes
- Command: `muuuuse 1 link 2 flow on 3 flow off 5 flow on`
- All targets (2, 3, 5) are treated identically, each with its own flow mode
- No more odd/even anchor logic

**NEW PARSING LOGIC:**
```javascript
function parseLinkTargets(args, seatId) {
  const relayTargets = [];
  let consumed = 0;
  let index = 0;

  while (index < args.length) {
    const targetSeatId = normalizeSeatId(args[index]);
    if (!targetSeatId || targetSeatId === seatId) {
      break;  // Can't relay to self
    }

    const targetFlowMode = parseFlowModeToken(args[index + 1], args[index + 2]);
    if (!targetFlowMode) {
      break;  // No flow mode found, stop parsing
    }

    upsertTarget(relayTargets, {
      targetSeatId,
      flowMode: targetFlowMode
    });

    index += 3;  // seat flow [on/off]
    consumed = index;
  }

  return { consumed, relayTargets };
}
```

**COMMAND EXAMPLES (v6):**
```bash
# Seat 1 relays to seats 2, 3, 5 with different flow modes
muuuuse 1 link 2 flow on 3 flow off 5 flow on

# Seat 2 relays to seats 1, 4 with same flow mode
muuuuse 2 link 1 flow off 4 flow off

# Seat 3 relays to just seat 1
muuuuse 3 link 1 flow on

# Seat 4 relays to 2 and 3
muuuuse 4 link 2 flow on 3 flow on
```

---

### 4. **Command Line Updates**

**USAGE CHANGES:**

Old:
```
muuuuse 1 flow on          # Anchor seat creates session
muuuuse 2 flow off         # Partner seat joins
muuuuse 3                  # Creates new pair
muuuuse 4 continue 1       # Routes 4 output to 1
```

New:
```
muuuuse 1 link 2 flow on              # Seat 1 relays to 2 (flow on)
muuuuse 2 link 1 flow off             # Seat 2 relays to 1 (flow off)
muuuuse 3 link 1 flow on 2 flow off   # Seat 3 relays to 1 (on) and 2 (off)
muuuuse status                        # Show all active seats and their links
muuuuse stop                          # Stop all seats
```

**FLOW MODE BEHAVIOR UNCHANGED:**
- `flow on` = relay both commentary and final answers
- `flow off` = relay final answers only

---

## File-by-File Change Summary

### `/root/muuuuse/src/util.js`

**REMOVE:**
- Lines 178-180: `isAnchorSeat(seatId)`
- Lines 182-188: `getPartnerSeatId(seatId)`
- Lines 328, 330: Exports of above functions

**KEEP:** Everything else (encoding, signing, file I/O, path management)

---

### `/root/muuuuse/src/runtime.js`

**REMOVE:**
- Lines 145-195: `findJoinableSessionName()`
- Lines 197-208: `waitForJoinableSessionName()`
- Lines 210-216: `resolveSessionName()`
- Lines 1017-1020: `partnerIsLive()`
- All references to `getPartnerSeatId()`, `isAnchorSeat()`
- Imports of these functions from util.js
- All `partnerSeatId` and `anchorSeatId` properties and usage
- `partnerPaths` and `partnerOffset`
- `initializeTrustMaterial()` (lines 697-716)
- `syncTrustState()`, `syncSeatOneTrust()`, `syncSeatTwoTrust()` (lines 718-855)
- `pullPartnerEvents()` (lines 1071-1136)
- Single `trustState` object

**ADD:**
- `createOrJoinSessionName(cwd, seatId)` - Create new session or find existing
- `syncMultiTargetTrust()` - Establish trust with all configured targets
- `pullInboundRelays()` - Read from all target seats' event logs
- `initializeTrustMaterial(targetSeatId)` - Set up per-target trust material
- Properties: `relayTargets`, `relayTargetPaths`, `targetOffsets`, `targetKeys`, `targetChallenges`

**MODIFY:**
- `ArmedSeat` constructor (lines 585-641)
- `emitAnswer()` (lines 1414-1461) - Sign for each target with target's challenge
- `forwardContinuation()` (lines 1463-1489) - Remove old continue logic
- Status tracking in `writeController()`, `writeMeta()`, `writeStatus()`
- Main loop in `run()` method

---

### `/root/muuuuse/src/cli.js`

**REMOVE:**
- Lines 87-95: `renderLinkTargets()` - Can be rewritten simpler
- Lines 156-244: `parseLinkTargets()` - Rewrite completely
- References to `partnerSeatId` special handling
- Lines 215: `getPartnerSeatId()` call

**ADD:**
- New `parseLinkTargets()` that creates `relayTargets` array
- Update error messages to not reference partner seats

**MODIFY:**
- Lines 57-66: `parseSeatOptions()` - Pass `relayTargets` instead of `continueTargets`
- Lines 74-106: `renderSeatStatus()` - Show all relay targets with their flow modes
- Line 110: Change `renderLinkTargets()` to show flat list of all targets

---

### `/root/muuuuse/src/agents.js`

**NO CHANGES** - This file handles agent output detection (Claude, Codex, Gemini) and is independent of pairing model

---

### `/root/muuuuse/package.json`

**MINOR:**
- Update version from 5.5.4 to 6.0.0
- Update description to reflect new relay model

---

## Trust Material Layout (v6)

Each seat's directory contains:

```
~/.muuuuse/sessions/{sessionName}/seat-{seatId}/
├── id_ed25519                    # Seat's private key (unchanged)
├── id_ed25519.pub                # Seat's public key (unchanged)
├── meta.json                     # Metadata (unchanged)
├── status.json                   # Status (updated structure)
├── events.jsonl                  # Events from agents (unchanged)
├── daemon.json                   # Daemon state (unchanged)
├── pipe.log                      # Raw PTY output (unchanged)
├── {relay-target-{targetSeatId}}/
│   ├── initiator_challenge.json  # Challenge if this seat initiated pairing
│   ├── responder_signature.json  # Signature if this seat responded to pairing
│   └── ack.json                  # Acknowledgment (if initiator)
└── continue.jsonl                # (DEPRECATED - kept for compatibility)
```

**NEW:** Each relay target gets its own subdirectory for pairing materials.

---

## Design Principles for v6

1. **Symmetry**: Any two seats can establish trust independently
2. **Flexibility**: Arbitrary many-to-many relay topology
3. **Independence**: Each relay path has its own challenge/signature pair
4. **Simplicity**: All targets treated equally with per-target flow mode
5. **Compatibility**: Session and event files remain mostly unchanged
6. **Robustness**: If one relay target is unavailable, others continue working

---

## Implementation Order

1. Remove `getPartnerSeatId()` and `isAnchorSeat()` from util.js
2. Add `createOrJoinSessionName()` to runtime.js
3. Refactor `ArmedSeat` constructor to use `relayTargets`
4. Implement new trust sync for multiple targets
5. Rewrite `pullPartnerEvents()` → `pullInboundRelays()`
6. Update `emitAnswer()` to sign for each target
7. Update CLI parsing in cli.js
8. Update status display
9. Update tests
10. Update README with new command syntax

