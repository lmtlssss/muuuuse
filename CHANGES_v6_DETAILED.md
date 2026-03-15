# Muuuuse v6 - Detailed Change List

## Summary
Transform from odd/even paired relay model to free-form multi-target relay model. Any seat can relay to any other seat with independent flow modes per target.

---

## File: `/root/muuuuse/src/util.js`

### Functions to REMOVE

#### `isAnchorSeat(seatId)` (Lines 178-180)
```javascript
function isAnchorSeat(seatId) {
  return normalizeSeatId(seatId) % 2 === 1;
}
```
**Reason**: No longer have anchor/partner distinction

#### `getPartnerSeatId(seatId)` (Lines 182-188)
```javascript
function getPartnerSeatId(seatId) {
  const normalized = normalizeSeatId(seatId);
  if (!normalized) {
    return null;
  }
  return isAnchorSeat(normalized) ? normalized + 1 : normalized - 1;
}
```
**Reason**: No computed partner; all pairings are explicit

### Exports to REMOVE

Lines 328, 330 in module.exports:
- `getPartnerSeatId,`
- `isAnchorSeat,`

### What STAYS

All other utilities remain:
- `hashText()`, `signText()`, `verifyText()` - Still needed for per-target trust
- `loadOrCreateSeatIdentity()` - Still needed for each seat's keypair
- `getSeatPaths()`, `getSessionPaths()` - Directory structure unchanged
- `readJson()`, `writeJson()`, `appendJsonl()` - File I/O unchanged
- All path construction helpers

---

## File: `/root/muuuuse/src/runtime.js`

### Functions to REMOVE

#### `findJoinableSessionName(currentPath, seatId = 2)` (Lines 145-195)
```javascript
function findJoinableSessionName(currentPath = process.cwd(), seatId = 2) {
  const normalizedSeatId = normalizeSeatId(seatId);
  const anchorSeatId = getPartnerSeatId(normalizedSeatId);
  if (!normalizedSeatId || !anchorSeatId || isAnchorSeat(normalizedSeatId)) {
    return null;  // Only even seats can join
  }
  // ... searches for anchor seat in existing sessions
}
```
**Reason**: No waiting for anchor seat; seats create/join independently

#### `waitForJoinableSessionName(currentPath, seatId = 2, timeoutMs = SEAT_JOIN_WAIT_MS)` (Lines 197-208)
```javascript
function waitForJoinableSessionName(currentPath = process.cwd(), seatId = 2, timeoutMs = SEAT_JOIN_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const sessionName = findJoinableSessionName(currentPath, seatId);
    if (sessionName) {
      return sessionName;
    }
    sleepSync(SEAT_JOIN_POLL_MS);
  }
  return null;
}
```
**Reason**: No longer need to wait

#### `resolveSessionName(currentPath = process.cwd(), seatId = 1)` (Lines 210-216)
```javascript
function resolveSessionName(currentPath = process.cwd(), seatId = 1) {
  if (isAnchorSeat(seatId)) {
    return createSessionName(currentPath);
  }
  return waitForJoinableSessionName(currentPath, seatId);
}
```
**Reason**: Both seats can independently create or join

### Functions to ADD

#### `createOrJoinSessionName(cwd, seatId)`
```javascript
function createOrJoinSessionName(cwd, seatId) {
  // 1. Look for existing session in cwd that has this seatId ready
  const existingSession = findExistingSession(cwd, seatId);
  if (existingSession) {
    return existingSession;
  }

  // 2. Create new session
  return createSessionName(cwd);
}

function findExistingSession(cwd, seatId) {
  // Find most recent session where:
  // - cwd matches
  // - seat directory exists
  // - not a stale/stopped session
  const candidates = listSessionNames()
    .map(sessionName => {
      const seatDir = getSeatDirIfExists(sessionName, seatId);
      if (!seatDir) return null;

      const sessionPaths = getSessionPaths(sessionName);
      const controller = readJson(sessionPaths.controllerPath, null);
      const stopRequest = readJson(sessionPaths.stopPath, null);

      if (!matchesWorkingPath(controller?.cwd, cwd)) {
        return null;
      }

      const requestedAtMs = Date.parse(stopRequest?.requestedAt || "");
      const createdAtMs = Date.parse(controller?.createdAt || "");
      if (Number.isFinite(requestedAtMs) && requestedAtMs > createdAtMs) {
        return null;  // Stopped session
      }

      return {
        sessionName,
        updatedAtMs: Date.parse(controller?.updatedAt || ""),
      };
    })
    .filter(e => e !== null)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return candidates[0]?.sessionName || null;
}
```

### Methods to REMOVE from ArmedSeat class

#### Constructor changes (Lines 585-641)

**REMOVE these properties:**
- Line 587: `this.partnerSeatId = getPartnerSeatId(options.seatId);`
- Line 588: `this.anchorSeatId = isAnchorSeat(options.seatId) ? ...`
- Line 590: `this.continueSeatId = normalizeContinueSeatId(...)`
- Line 591: `this.continueTargets = Array.isArray(...) ? ... : [];`
- Line 604: `this.partnerPaths = getSeatPaths(..., this.partnerSeatId);`
- Line 606: `this.partnerOffset = getFileSize(...)`

**Lines 596-601: Change session resolution**
```javascript
// OLD:
this.sessionName = resolveSessionName(this.cwd, this.seatId);
if (!this.sessionName) {
  throw new Error(
    `No armed \`muuuuse ${this.partnerSeatId}\` seat is waiting in this cwd. Run \`muuuuse ${this.partnerSeatId}\` first.`
  );
}

// NEW:
this.sessionName = createOrJoinSessionName(this.cwd, this.seatId);
if (!this.sessionName) {
  throw new Error(
    `Failed to create or find session for seat ${this.seatId} in ${this.cwd}`
  );
}
```

**ADD these properties:**
```javascript
this.relayTargets = Array.isArray(options.relayTargets) ? options.relayTargets : [];
// Format: [{ targetSeatId: 2, flowMode: "on" }, { targetSeatId: 3, flowMode: "off" }]

this.relayTargetPaths = {};  // Maps: targetSeatId -> paths object
for (const target of this.relayTargets) {
  this.relayTargetPaths[target.targetSeatId] = getSeatPaths(this.sessionName, target.targetSeatId);
}

this.targetOffsets = {};  // Maps: targetSeatId -> file offset
for (const target of this.relayTargets) {
  this.targetOffsets[target.targetSeatId] = getFileSize(this.relayTargetPaths[target.targetSeatId].eventsPath);
}

this.targetKeys = {};  // Maps: targetSeatId -> public key
this.targetChallenges = {};  // Maps: targetSeatId -> challenge
```

**ADD validation:**
```javascript
for (const target of this.relayTargets) {
  if (target.targetSeatId === this.seatId) {
    throw new Error(`Seat ${this.seatId} cannot relay to itself`);
  }
}
```

#### Remove `initializeTrustMaterial()` (Lines 697-716)
```javascript
initializeTrustMaterial() {
  this.identity = loadOrCreateSeatIdentity(this.paths);

  if (!isAnchorSeat(this.seatId)) {  // <-- Uses isAnchorSeat
    return;
  }
  // ... anchor-only logic
}
```
**Reason**: Trust init now per-target and symmetric

#### Remove `syncTrustState()` (Lines 718-729)
```javascript
syncTrustState() {
  if (!this.identity) {
    this.initializeTrustMaterial();
  }

  if (isAnchorSeat(this.seatId)) {  // <-- Uses isAnchorSeat
    this.syncSeatOneTrust();
    return;
  }

  this.syncSeatTwoTrust();
}
```
**Reason**: Replace with symmetric per-target sync

#### Remove `syncSeatOneTrust()` (Lines 731-796)
**Reason**: Anchor-specific logic no longer needed

#### Remove `syncSeatTwoTrust()` (Lines 798-855)
**Reason**: Non-anchor-specific logic no longer needed

#### Remove `isPaired()` (Lines 857-861)
```javascript
isPaired() {
  return this.trustState.phase === "paired" && ...;
}
```
**Reason**: Now check per-target trust status

#### Remove `partnerIsLive()` (Lines 1017-1020)
```javascript
partnerIsLive() {
  const partner = readJson(this.partnerPaths.statusPath, null);
  return Boolean(partner?.pid && isPidAlive(partner.pid));
}
```
**Reason**: No single partner to check

#### Remove `pullPartnerEvents()` (Lines 1071-1136)
```javascript
async pullPartnerEvents() {
  const { nextOffset, text } = readAppendedText(this.partnerPaths.eventsPath, this.partnerOffset);
  this.partnerOffset = nextOffset;
  if (!text.trim() || !this.child || this.stopped || !this.isPaired()) {
    return;
  }
  // ... pulls from one partner's events, verifies with one key
}
```
**Reason**: Replace with multi-target version

#### Remove `trustState` property and references

**Lines 624-629: REMOVE**
```javascript
this.trustState = {
  challenge: null,
  peerPublicKey: null,
  phase: isAnchorSeat(this.seatId) ? "waiting_for_peer_signature" : "waiting_for_anchor_key",
  pairedAt: null,
};
```

**Replace all `this.trustState.challenge` with `this.targetChallenges[targetSeatId]`**
**Replace all `this.trustState.peerPublicKey` with `this.targetKeys[targetSeatId]`**

### Methods to ADD to ArmedSeat class

#### `initializeTrustMaterial()`
```javascript
initializeTrustMaterial() {
  // Load or create this seat's keypair (one per seat, not per-target)
  this.identity = loadOrCreateSeatIdentity(this.paths);
}
```

#### `syncMultiTargetTrust()`
```javascript
syncMultiTargetTrust() {
  if (!this.identity) {
    this.initializeTrustMaterial();
  }

  for (const target of this.relayTargets) {
    this.syncTargetTrust(target.targetSeatId);
  }
}

syncTargetTrust(targetSeatId) {
  const targetPaths = this.relayTargetPaths[targetSeatId];

  // Check if we already have this target's key
  if (this.targetKeys[targetSeatId]) {
    return;
  }

  // Try to read initiator challenge from target's seat directory
  const targetInitiatorChallenge = readJson(
    path.join(targetPaths.dir, 'initiator_challenge.json'),
    null
  );

  if (!targetInitiatorChallenge) {
    // We need to initiate pairing
    this.initiateTargetPairing(targetSeatId);
  } else {
    // Target initiated; we respond
    this.respondToTargetPairing(targetSeatId, targetInitiatorChallenge);
  }
}

initiateTargetPairing(targetSeatId) {
  const targetPaths = this.relayTargetPaths[targetSeatId];
  const challengeFile = path.join(targetPaths.dir, 'initiator_challenge.json');

  const challenge = createId(48);
  writeJson(challengeFile, {
    sessionName: this.sessionName,
    challenge,
    publicKey: this.identity.publicKey,
    createdAt: new Date().toISOString(),
  });

  this.targetChallenges[targetSeatId] = challenge;
}

respondToTargetPairing(targetSeatId, targetInitiatorChallenge) {
  const targetPaths = this.relayTargetPaths[targetSeatId];
  const sigFile = path.join(targetPaths.dir, 'responder_signature.json');

  const signature = signText(
    JSON.stringify({
      sessionName: this.sessionName,
      challenge: targetInitiatorChallenge.challenge,
      initiatorKey: targetInitiatorChallenge.publicKey,
      responderKey: this.identity.publicKey,
    }),
    this.identity.privateKey
  );

  writeJson(sigFile, {
    sessionName: this.sessionName,
    challenge: targetInitiatorChallenge.challenge,
    initiatorKey: targetInitiatorChallenge.publicKey,
    responderKey: this.identity.publicKey,
    signature,
    signedAt: new Date().toISOString(),
  });

  this.targetKeys[targetSeatId] = targetInitiatorChallenge.publicKey;
  this.targetChallenges[targetSeatId] = targetInitiatorChallenge.challenge;
}
```

#### `pullInboundRelays()`
```javascript
async pullInboundRelays() {
  for (const target of this.relayTargets) {
    const targetPaths = this.relayTargetPaths[target.targetSeatId];
    const offset = this.targetOffsets[target.targetSeatId] || 0;
    const { nextOffset, text } = readAppendedText(targetPaths.eventsPath, offset);
    this.targetOffsets[target.targetSeatId] = nextOffset;

    if (!text.trim() || !this.child || this.stopped) {
      continue;
    }

    const entries = parseAnswerEntries(text);
    for (const entry of entries) {
      if (this.stopped || this.stopRequested()) {
        this.requestStop("stop_requested");
        return;
      }

      // Use target-specific flow mode
      if (!shouldAcceptInboundEntry(target.flowMode, entry)) {
        continue;
      }

      // Verify with target-specific key and challenge
      const targetKey = this.targetKeys[target.targetSeatId];
      const targetChallenge = this.targetChallenges[target.targetSeatId];

      if (!targetKey || !targetChallenge) {
        continue;  // Haven't paired yet
      }

      const payload = sanitizeRelayText(entry.text);
      const signaturePayload = buildAnswerSignaturePayload(this.sessionName, targetChallenge, {
        chainId: entry.chainId || entry.id,
        hop: Number.isInteger(entry.hop) ? entry.hop : 0,
        id: entry.id,
        seatId: entry.seatId,
        origin: entry.origin || "unknown",
        phase: getRelayPhase(entry),
        createdAt: entry.createdAt,
        text: payload,
      });

      if (
        !payload ||
        entry.challenge !== targetChallenge ||
        entry.publicKey !== targetKey ||
        typeof entry.signature !== "string" ||
        !verifyText(signaturePayload, entry.signature, targetKey)
      ) {
        continue;
      }

      const delivered = await sendTextAndEnter(
        this.child,
        payload,
        () => this.stopped || this.stopRequested() || !this.child || Boolean(this.childExit)
      );

      if (!delivered) {
        this.requestStop("relay_aborted");
        return;
      }

      if (this.stopped || this.stopRequested()) {
        this.requestStop("stop_requested");
        return;
      }

      const deliveredAtMs = Date.now();
      this.pendingInboundContext = {
        chainId: entry.chainId || entry.id,
        deliveredAtMs,
        expiresAtMs: deliveredAtMs + PENDING_RELAY_CONTEXT_TTL_MS,
        hop: Number.isInteger(entry.hop) ? entry.hop : 0,
      };

      this.relayCount += 1;
      this.rememberInboundRelay(payload);
      this.log(`[${target.targetSeatId} -> ${this.seatId}] ${previewText(payload)}`);
    }
  }
}
```

#### `emitAnswer()` - Update signature for multiple targets
```javascript
emitAnswer(entry) {
  if (this.stopped) {
    return;
  }

  const payload = sanitizeRelayText(entry.text);
  if (!payload || !this.identity) {
    return;
  }

  const answerKey = buildAnswerKey(entry, payload);
  if (this.hasRecentEmittedAnswer(answerKey)) {
    this.log(`[${this.seatId}] suppressed duplicate final answer: ${previewText(payload)}`);
    return;
  }

  const mirroredInbound = this.takeMirroredInboundRelay(payload);
  if (mirroredInbound) {
    this.log(`[${this.seatId}] suppressed mirrored relay: ${previewText(payload)}`);
    return;
  }

  const pendingInboundContext = this.getPendingInboundContext();
  const entryId = entry.id || createId(12);

  // Sign once for each relay target
  for (const target of this.relayTargets) {
    const targetChallenge = this.targetChallenges[target.targetSeatId];
    if (!targetChallenge) {
      continue;  // Haven't paired with this target yet
    }

    const signedEntry = {
      id: entryId,
      type: "answer",
      seatId: this.seatId,
      origin: entry.origin || "unknown",
      phase: entry.phase || "final_answer",
      text: payload,
      createdAt: entry.createdAt || new Date().toISOString(),
      chainId: pendingInboundContext?.chainId || entry.chainId || entryId,
      hop: pendingInboundContext ? pendingInboundContext.hop + 1 : 0,
      challenge: targetChallenge,
      publicKey: this.identity.publicKey,
    };

    signedEntry.signature = signText(
      buildAnswerSignaturePayload(this.sessionName, targetChallenge, signedEntry),
      this.identity.privateKey
    );

    // Write to each target's event file
    appendJsonl(this.relayTargetPaths[target.targetSeatId].eventsPath, signedEntry);
  }

  this.rememberEmittedAnswer(answerKey);
  this.log(`[${this.seatId}] ${previewText(payload)}`);
}
```

### Methods to MODIFY in ArmedSeat class

#### `launchShell()` (Lines 863-899)
**Change line 867:**
```javascript
// OLD:
this.initializeTrustMaterial();
this.writeController();

// NEW:
this.initializeTrustMaterial();
this.syncMultiTargetTrust();  // NEW: sync with all relay targets immediately
this.writeController();
```

#### `writeMeta()` (Lines 663-678)
```javascript
writeMeta(extra = {}) {
  writeJson(this.paths.metaPath, {
    seatId: this.seatId,
    relayTargets: this.relayTargets,  // CHANGE: was continueTargets/continueSeatId
    sessionName: this.sessionName,
    flowMode: this.relayTargets[0]?.flowMode || "off",  // DEPRECATED - keep for compat
    cwd: this.cwd,
    pid: process.pid,
    childPid: this.childPid,
    command: [resolveShell(), ...resolveShellArgs(resolveShell())],
    startedAt: this.startedAt,
    ...extra,
  });
}
```

#### `writeStatus()` (Lines 680-695)
```javascript
writeStatus(extra = {}) {
  writeJson(this.paths.statusPath, {
    seatId: this.seatId,
    relayTargets: this.relayTargets,  // CHANGE
    sessionName: this.sessionName,
    cwd: this.cwd,
    pid: process.pid,
    childPid: this.childPid,
    relayCount: this.relayCount,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}
```

#### `async tick()` (Around line 1491)
**Change the relay polling:**
```javascript
async tick() {
  if (this.stopRequested()) {
    // ... existing stop logic
  }

  this.syncMultiTargetTrust();  // Continuous trust sync for new targets
  await this.pullInboundRelays();  // CHANGE: was this.pullPartnerEvents()
  await this.pullContinuationEvents();  // Keep for backward compat or remove
  // ... rest of tick
}
```

#### `writeController()` (Lines 643-657)
**Update to track relay targets instead of partner:**
```javascript
writeController(extra = {}) {
  const current = readJson(this.sessionPaths.controllerPath, {});
  writeJson(this.sessionPaths.controllerPath, {
    sessionName: this.sessionName,
    cwd: this.cwd,
    createdAt: current.createdAt || this.startedAt,
    updatedAt: new Date().toISOString(),
    activeSeats: this.getActiveSeatIds(),  // NEW: list all active seats
    pid: process.pid,  // This seat's wrapper PID
    ...extra,
  });
}
```

### Imports to UPDATE

**Line 23: REMOVE**
```javascript
  getPartnerSeatId,
```

**Line 28: REMOVE**
```javascript
  isAnchorSeat,
```

**Add new imports if needed:**
```javascript
const path = require("node:path");  // May need for per-target challenge paths
```

---

## File: `/root/muuuuse/src/cli.js`

### Functions to REMOVE

#### `renderLinkTargets()` (Lines 108-123) - Optional rewrite
```javascript
function renderLinkTargets(seat) {
  const targets = [];
  if (seat.partnerSeatId) {
    targets.push({
      targetSeatId: seat.partnerSeatId,
      flowMode: seat.flowMode || "off",
    });
  }
  for (const target of Array.isArray(seat.continueTargets) ? seat.continueTargets : []) {
    targets.push(target);
  }
  // ... render
}
```
**Can be rewritten simpler or removed entirely if output is flattened**

#### `parseLinkTargets()` (Lines 214-244) - Complete rewrite
```javascript
function parseLinkTargets(args, seatId, defaultFlowMode) {
  const partnerSeatId = seatId ? getPartnerSeatId(seatId) : null;  // REMOVE
  const continueTargets = [];
  let flowMode = defaultFlowMode;
  let consumed = 0;

  while (consumed < args.length) {
    const targetSeatId = normalizeSeatId(args[consumed]);
    if (!targetSeatId) {
      break;
    }

    const targetFlowMode = parseFlowModeToken(args[consumed + 1], args[consumed + 2]);
    if (!targetFlowMode) {
      break;
    }

    if (targetSeatId === partnerSeatId) {  // REMOVE: special partner handling
      flowMode = targetFlowMode;
    } else {
      upsertTarget(continueTargets, {
        targetSeatId,
        flowMode: targetFlowMode,
      });
    }

    consumed += 3;
  }

  return { consumed, continueTargets, flowMode };
}
```

### Functions to ADD/REWRITE

#### `parseLinkTargets()` - New implementation
```javascript
function parseLinkTargets(args, seatId) {
  const relayTargets = [];
  let consumed = 0;
  let index = 0;

  while (index < args.length) {
    const targetSeatId = normalizeSeatId(args[index]);
    if (!targetSeatId) {
      break;
    }

    if (targetSeatId === seatId) {
      break;  // Can't relay to self
    }

    const targetFlowMode = parseFlowModeToken(args[index + 1], args[index + 2]);
    if (!targetFlowMode) {
      break;  // Must have explicit flow mode
    }

    upsertTarget(relayTargets, {
      targetSeatId,
      flowMode: targetFlowMode
    });

    index += 3;
    consumed = index;
  }

  return { consumed, relayTargets };
}
```

### Methods to MODIFY in cli.js

#### `parseSeatOptions()` (Lines 125-178)
**Change all references from `continueTargets`/`continueSeatId` to `relayTargets`:**

```javascript
function parseSeatOptions(command, args) {
  const seatId = normalizeSeatId(command);
  let relayTargets = [];  // CHANGE: was continueTargets
  let index = 0;

  while (index < args.length) {
    const token = String(args[index] || "").trim().toLowerCase();

    if (token === "flow") {
      // Optional: keep for backward compat, but flows are now per-target
      const flowToken = String(args[index + 1] || "").trim().toLowerCase();
      if (flowToken === "on" || flowToken === "off") {
        index += 2;
        continue;
      }
      break;
    }

    if (token === "link") {
      const parsedLinks = parseLinkTargets(args.slice(index + 1), seatId);  // CHANGE
      if (parsedLinks.consumed > 0) {
        relayTargets = mergeTargets(relayTargets, parsedLinks.relayTargets);  // CHANGE
        index += 1 + parsedLinks.consumed;
        continue;
      }
      break;
    }

    break;
  }

  if (index === args.length) {
    return { relayTargets };  // CHANGE
  }

  throw new Error(
    `\`muuuuse ${command}\` accepts no extra arguments or \`link <seat> flow on [<seat> flow off ...]\`. Run it directly in the terminal you want to arm.`  // CHANGE message
  );
}
```

#### `main()` (Lines 4-72)
**Change ArmedSeat instantiation:**

```javascript
async function main(argv = process.argv.slice(2)) {
  // ... existing command parsing for stop/status ...

  const seatId = normalizeSeatId(command);
  if (seatId) {
    const { relayTargets } = parseSeatOptions(command, argv.slice(1));  // CHANGE
    const seat = new ArmedSeat({
      cwd: process.cwd(),
      relayTargets,  // CHANGE: was continueTargets/continueSeatId
      seatId,
    });
    const code = await seat.run();
    process.exit(code);
  }
  // ...
}
```

#### `renderSeatStatus()` (Lines 74-106)
**Simplify relay targets display:**

```javascript
function renderSeatStatus(seat) {
  const bits = [
    `seat ${seat.seatId}: ${seat.state}`,
    `agent ${seat.agent || "idle"}`,
    `relays ${seat.relayCount}`,
    `wrapper ${seat.wrapperPid || "-"}`,
    `child ${seat.childPid || "-"}`,
  ];

  const renderedLinks = renderLinkTargets(seat);  // CHANGE: simplified
  if (renderedLinks) {
    bits.push(`links ${renderedLinks}`);
  }

  if (seat.lastAnswerAt) {
    bits.push(`last answer ${seat.lastAnswerAt}`);
  }

  let output = `${bits.join(" · ")}\n`;
  if (seat.cwd) {
    output += `cwd: ${seat.cwd}\n`;
  }
  if (seat.log) {
    output += `log: ${seat.log}\n`;
  }
  return output;
}
```

#### `renderLinkTargets()` - Simplified (Lines 108-123)
```javascript
function renderLinkTargets(seat) {
  const relayTargets = seat.relayTargets || [];  // CHANGE
  return relayTargets
    .map((target) => `${target.targetSeatId}:${target.flowMode}`)
    .join(", ");
}
```

### Imports to UPDATE

**Line 1: REMOVE**
```javascript
const { BRAND, getPartnerSeatId, normalizeSeatId, usage } = require("./util");
// Change to:
const { BRAND, normalizeSeatId, usage } = require("./util");
```

---

## File: `/root/muuuuse/package.json`

### Changes

**Line 3: Update version**
```json
  "version": "6.0.0",
```

**Line 4: Update description**
```json
  "description": "🔌Muuuuse is a terminal relay. Any seat can relay its agent output to any other seat with independent flow modes.",
```

---

## File: `/root/muuuuse/README.md`

### Content to UPDATE

Update usage examples:

```bash
# OLD:
muuuuse 1 flow on
muuuuse 2 flow off
muuuuse 3 flow on
muuuuse 4 continue 1

# NEW:
muuuuse 1 link 2 flow on
muuuuse 2 link 1 flow off
muuuuse 3 link 1 flow on 2 flow off
muuuuse 4 link 2 flow on 3 flow on
```

Update description of flow modes and how seats connect.

---

## File: `/root/muuuuse/src/agents.js`

**NO CHANGES** - This file is independent of the pairing model

---

## Summary Table

| File | Changes | Impact |
|------|---------|--------|
| util.js | Remove 2 functions (getPartnerSeatId, isAnchorSeat) | Low - removes 10 lines |
| runtime.js | Remove 5 functions, refactor ArmedSeat class, add 3+ new methods | High - 40%+ rewrite |
| cli.js | Rewrite parseLinkTargets, update parseSeatOptions, minor UI changes | Medium - 15% rewrite |
| package.json | Version bump, description update | Trivial |
| README.md | Update command examples, fix documentation | Low |
| agents.js | No changes | None |

---

## Testing Strategy

1. **Unit tests** - Test new seat discovery and pairing logic
2. **Integration tests** - Verify relay chains: 1→2, 1→2→3, 1→2,3 (fan-out)
3. **Flow mode tests** - Verify per-target flow modes work correctly
4. **Backward compat** - Ensure session files remain mostly compatible
5. **Edge cases** - Self-relay (should fail), missing targets, stopped seats

