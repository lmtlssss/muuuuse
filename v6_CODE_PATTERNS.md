# Muuuuse v6 - Code Patterns & Examples

## Pattern 1: ArmedSeat Constructor

### v5 Pattern (Old)
```javascript
class ArmedSeat {
  constructor(options) {
    this.seatId = options.seatId;

    // Computed partner based on odd/even
    this.partnerSeatId = getPartnerSeatId(options.seatId);  // 1→2, 2→1, 3→4, 4→3
    this.anchorSeatId = isAnchorSeat(options.seatId) ? options.seatId : this.partnerSeatId;

    // Single flow mode
    this.flowMode = normalizeFlowMode(options.flowMode);

    // Old "continue" model - forwarding to other seats
    this.continueSeatId = normalizeContinueSeatId(options.continueSeatId);
    this.continueTargets = Array.isArray(options.continueTargets) ? options.continueTargets : [];

    // Session resolution: odd creates, even waits for odd
    this.sessionName = resolveSessionName(this.cwd, this.seatId);
    if (!this.sessionName) {
      throw new Error(`No armed \`muuuuse ${this.partnerSeatId}\` seat waiting...`);
    }

    // Single partner path
    this.partnerPaths = getSeatPaths(this.sessionName, this.partnerSeatId);
    this.partnerOffset = getFileSize(this.partnerPaths.eventsPath);
  }
}
```

### v6 Pattern (New)
```javascript
class ArmedSeat {
  constructor(options) {
    this.seatId = options.seatId;

    // Explicit relay targets from command line
    this.relayTargets = Array.isArray(options.relayTargets) ? options.relayTargets : [];
    // Format: [{ targetSeatId: 2, flowMode: "on" }, { targetSeatId: 3, flowMode: "off" }]

    // Validate no self-relay
    for (const target of this.relayTargets) {
      if (target.targetSeatId === this.seatId) {
        throw new Error(`Seat ${this.seatId} cannot relay to itself`);
      }
    }

    // Any seat can create or join (no odd/even distinction)
    this.sessionName = createOrJoinSessionName(this.cwd, this.seatId);
    if (!this.sessionName) {
      throw new Error(`Failed to create or find session for seat ${this.seatId}`);
    }

    // Paths for all relay targets
    this.relayTargetPaths = {};
    this.targetOffsets = {};
    for (const target of this.relayTargets) {
      const paths = getSeatPaths(this.sessionName, target.targetSeatId);
      this.relayTargetPaths[target.targetSeatId] = paths;
      this.targetOffsets[target.targetSeatId] = getFileSize(paths.eventsPath);
    }

    // Per-target trust state
    this.targetKeys = {};  // Maps: targetSeatId → publicKey
    this.targetChallenges = {};  // Maps: targetSeatId → challenge
  }
}
```

---

## Pattern 2: Session Discovery

### v5 Pattern
```javascript
function resolveSessionName(currentPath = process.cwd(), seatId = 1) {
  if (isAnchorSeat(seatId)) {
    // Odd seat creates new session
    return createSessionName(currentPath);
  }

  // Even seat waits for odd seat
  return waitForJoinableSessionName(currentPath, seatId);
}

function findJoinableSessionName(currentPath = process.cwd(), seatId = 2) {
  const normalizedSeatId = normalizeSeatId(seatId);
  const anchorSeatId = getPartnerSeatId(normalizedSeatId);

  // Only even seats can join
  if (!normalizedSeatId || !anchorSeatId || isAnchorSeat(normalizedSeatId)) {
    return null;
  }

  // Search for session with the odd seat (anchor) active
  const candidates = listSessionNames()
    .map((sessionName) => {
      const anchorPaths = getSeatPaths(sessionName, anchorSeatId);
      const anchorStatus = readJson(anchorPaths.statusPath, null);
      const anchorLive = isPidAlive(anchorStatus?.pid);

      // Only return if anchor is live and even is not
      if (!anchorLive) return null;

      return { sessionName, updatedAtMs: Date.parse(anchorStatus?.updatedAt) };
    })
    .filter(e => e !== null)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return candidates[0]?.sessionName || null;
}
```

### v6 Pattern
```javascript
function createOrJoinSessionName(cwd, seatId) {
  // First, try to find an existing session with this seat
  const existingSession = findExistingSession(cwd, seatId);
  if (existingSession) {
    return existingSession;
  }

  // No existing session; create new one
  return createSessionName(cwd);
}

function findExistingSession(cwd, seatId) {
  const candidates = listSessionNames()
    .map((sessionName) => {
      // Check if this session has the seat directory
      const seatDir = getSeatDirIfExists(sessionName, seatId);
      if (!seatDir) return null;

      // Check if session cwd matches
      const sessionPaths = getSessionPaths(sessionName);
      const controller = readJson(sessionPaths.controllerPath, null);
      if (!matchesWorkingPath(controller?.cwd, cwd)) return null;

      // Check if not stopped
      const stopRequest = readJson(sessionPaths.stopPath, null);
      const requestedAtMs = Date.parse(stopRequest?.requestedAt || "");
      const createdAtMs = Date.parse(controller?.createdAt || "");
      if (Number.isFinite(requestedAtMs) && requestedAtMs > createdAtMs) {
        return null;  // Session was stopped
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

**Key difference**: v6 doesn't care about partner seats, only whether the current seat has a directory in the session.

---

## Pattern 3: Trust Synchronization

### v5 Pattern (Asymmetric by seat ID)
```javascript
syncTrustState() {
  if (!this.identity) {
    this.initializeTrustMaterial();
  }

  if (isAnchorSeat(this.seatId)) {
    this.syncSeatOneTrust();  // Odd seat: generate challenge
    return;
  }

  this.syncSeatTwoTrust();  // Even seat: sign challenge
}

syncSeatOneTrust() {
  // Odd seat logic
  const challengeRecord = readSeatChallenge(this.paths, this.sessionName);
  // ... wait for partner to sign ...
}

syncSeatTwoTrust() {
  // Even seat logic
  const challengeRecord = readSeatChallenge(this.partnerPaths, this.sessionName);
  // ... sign partner's challenge ...
}
```

### v6 Pattern (Symmetric, per-target)
```javascript
syncMultiTargetTrust() {
  if (!this.identity) {
    this.initializeTrustMaterial();
  }

  // Sync with each relay target independently
  for (const target of this.relayTargets) {
    this.syncTargetTrust(target.targetSeatId);
  }
}

syncTargetTrust(targetSeatId) {
  const targetPaths = this.relayTargetPaths[targetSeatId];

  // Already paired with this target?
  if (this.targetKeys[targetSeatId]) {
    return;
  }

  // Try to read initiator challenge from target
  const targetInitiatorChallenge = readJson(
    path.join(targetPaths.dir, 'initiator_challenge.json'),
    null
  );

  if (!targetInitiatorChallenge) {
    // Target hasn't initiated; we initiate
    this.initiateTargetPairing(targetSeatId);
  } else {
    // Target initiated; we respond
    this.respondToTargetPairing(targetSeatId, targetInitiatorChallenge);
  }
}

initiateTargetPairing(targetSeatId) {
  const targetPaths = this.relayTargetPaths[targetSeatId];
  const challenge = createId(48);

  writeJson(path.join(targetPaths.dir, 'initiator_challenge.json'), {
    sessionName: this.sessionName,
    challenge,
    publicKey: this.identity.publicKey,
    createdAt: new Date().toISOString(),
  });

  this.targetChallenges[targetSeatId] = challenge;
}

respondToTargetPairing(targetSeatId, targetInitiatorChallenge) {
  const targetPaths = this.relayTargetPaths[targetSeatId];

  const signature = signText(
    JSON.stringify({
      sessionName: this.sessionName,
      challenge: targetInitiatorChallenge.challenge,
      initiatorKey: targetInitiatorChallenge.publicKey,
      responderKey: this.identity.publicKey,
    }),
    this.identity.privateKey
  );

  writeJson(path.join(targetPaths.dir, 'responder_signature.json'), {
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

**Key differences**:
- v5: Role based on seat ID parity (odd=initiator, even=responder)
- v6: Role based on who writes first (either can initiate)
- v5: One challenge per session
- v6: One challenge per target per seat

---

## Pattern 4: Pulling Inbound Events

### v5 Pattern (Single Partner)
```javascript
async pullPartnerEvents() {
  const { nextOffset, text } = readAppendedText(
    this.partnerPaths.eventsPath,
    this.partnerOffset
  );
  this.partnerOffset = nextOffset;

  if (!text.trim() || !this.child || this.stopped || !this.isPaired()) {
    return;
  }

  const entries = parseAnswerEntries(text);
  for (const entry of entries) {
    // Check flow mode (one per seat)
    if (!shouldAcceptInboundEntry(this.flowMode, entry)) {
      continue;
    }

    // Verify signature (one key per seat)
    if (
      entry.challenge !== this.trustState.challenge ||
      entry.publicKey !== this.trustState.peerPublicKey ||
      !verifyText(signaturePayload, entry.signature, this.trustState.peerPublicKey)
    ) {
      continue;
    }

    const delivered = await sendTextAndEnter(this.child, entry.text, ...);
    this.log(`[${this.partnerSeatId} -> ${this.seatId}] ${previewText(entry.text)}`);
  }
}
```

### v6 Pattern (Multiple Targets)
```javascript
async pullInboundRelays() {
  // Process events from each relay target
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
      // Check target-specific flow mode
      if (!shouldAcceptInboundEntry(target.flowMode, entry)) {
        continue;
      }

      // Verify with target-specific key and challenge
      const targetKey = this.targetKeys[target.targetSeatId];
      const targetChallenge = this.targetChallenges[target.targetSeatId];

      if (!targetKey || !targetChallenge) {
        continue;  // Haven't paired yet
      }

      // Verify signature
      if (
        entry.challenge !== targetChallenge ||
        entry.publicKey !== targetKey ||
        !verifyText(signaturePayload, entry.signature, targetKey)
      ) {
        continue;
      }

      const delivered = await sendTextAndEnter(this.child, entry.text, ...);
      this.log(`[${target.targetSeatId} -> ${this.seatId}] ${previewText(entry.text)}`);
    }
  }
}
```

**Key differences**:
- v5: Single loop for one partner
- v6: Outer loop for each target, inner loop for entries
- v5: One flow mode for all inbound
- v6: Per-target flow mode
- v5: One key/challenge pair
- v6: Per-target key/challenge pairs

---

## Pattern 5: Emitting Answers

### v5 Pattern (Single Signature)
```javascript
emitAnswer(entry) {
  const payload = sanitizeRelayText(entry.text);
  if (!payload || !this.identity || !this.trustState.challenge) {
    return;
  }

  const signedEntry = {
    id: entryId,
    type: "answer",
    seatId: this.seatId,
    origin: entry.origin,
    phase: entry.phase,
    text: payload,
    createdAt: entry.createdAt,
    chainId: pendingInboundContext?.chainId || entryId,
    hop: pendingInboundContext ? pendingInboundContext.hop + 1 : 0,
    challenge: this.trustState.challenge,  // Single challenge
    publicKey: this.identity.publicKey,
  };

  signedEntry.signature = signText(
    buildAnswerSignaturePayload(this.sessionName, this.trustState.challenge, signedEntry),
    this.identity.privateKey
  );

  // Single target
  appendJsonl(this.paths.eventsPath, signedEntry);
  this.forwardContinuation(signedEntry);  // Old forwarding model
}
```

### v6 Pattern (Multiple Signatures)
```javascript
emitAnswer(entry) {
  const payload = sanitizeRelayText(entry.text);
  if (!payload || !this.identity) {
    return;
  }

  const entryId = entry.id || createId(12);
  const pendingInboundContext = this.getPendingInboundContext();

  // Sign once for EACH relay target with THAT target's challenge
  for (const target of this.relayTargets) {
    const targetChallenge = this.targetChallenges[target.targetSeatId];

    if (!targetChallenge) {
      continue;  // Haven't paired with this target yet
    }

    const signedEntry = {
      id: entryId,
      type: "answer",
      seatId: this.seatId,
      origin: entry.origin,
      phase: entry.phase,
      text: payload,
      createdAt: entry.createdAt,
      chainId: pendingInboundContext?.chainId || entryId,
      hop: pendingInboundContext ? pendingInboundContext.hop + 1 : 0,
      challenge: targetChallenge,  // PER-TARGET challenge
      publicKey: this.identity.publicKey,
    };

    signedEntry.signature = signText(
      buildAnswerSignaturePayload(this.sessionName, targetChallenge, signedEntry),
      this.identity.privateKey
    );

    // Write to each target's event file
    appendJsonl(this.relayTargetPaths[target.targetSeatId].eventsPath, signedEntry);
  }
}
```

**Key differences**:
- v5: One answer, one signature, one challenge
- v6: One answer, N signatures (one per target with target's challenge)
- v5: Single eventsPath
- v6: One entry per target's eventsPath

---

## Pattern 6: CLI Parsing

### v5 Pattern
```javascript
function parseLinkTargets(args, seatId, defaultFlowMode) {
  const partnerSeatId = seatId ? getPartnerSeatId(seatId) : null;
  const continueTargets = [];
  let flowMode = defaultFlowMode;
  let consumed = 0;

  while (consumed < args.length) {
    const targetSeatId = normalizeSeatId(args[consumed]);
    if (!targetSeatId) break;

    const targetFlowMode = parseFlowModeToken(args[consumed + 1], args[consumed + 2]);
    if (!targetFlowMode) break;

    // Special handling for partner
    if (targetSeatId === partnerSeatId) {
      flowMode = targetFlowMode;  // Partner gets its own flow mode
    } else {
      // Other targets are "continue" targets
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

### v6 Pattern
```javascript
function parseLinkTargets(args, seatId) {
  const relayTargets = [];
  let consumed = 0;
  let index = 0;

  while (index < args.length) {
    const targetSeatId = normalizeSeatId(args[index]);
    if (!targetSeatId) break;

    if (targetSeatId === seatId) {
      break;  // Can't relay to self
    }

    const targetFlowMode = parseFlowModeToken(args[index + 1], args[index + 2]);
    if (!targetFlowMode) break;

    // All targets treated uniformly
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

**Key differences**:
- v5: Special case for partner + separate "continue" targets
- v6: All targets uniform with per-target flow mode
- v5: Returns `{ consumed, continueTargets, flowMode }`
- v6: Returns `{ consumed, relayTargets }`

---

## Pattern 7: Status Display

### v5 Pattern
```javascript
function renderLinkTargets(seat) {
  const targets = [];

  // Partner is special
  if (seat.partnerSeatId) {
    targets.push({
      targetSeatId: seat.partnerSeatId,
      flowMode: seat.flowMode || "off",
    });
  }

  // Continue targets are separate
  for (const target of Array.isArray(seat.continueTargets) ? seat.continueTargets : []) {
    targets.push(target);
  }

  return targets
    .map((target) => `${target.targetSeatId}:${target.flowMode}`)
    .join(", ");
}
```

### v6 Pattern
```javascript
function renderLinkTargets(seat) {
  const relayTargets = seat.relayTargets || [];

  return relayTargets
    .map((target) => `${target.targetSeatId}:${target.flowMode}`)
    .join(", ");
}
```

**Key differences**:
- v5: Two separate properties (partnerSeatId, continueTargets)
- v6: Single relayTargets array

---

## Summary of Structural Changes

| Aspect | v5 | v6 |
|--------|----|----|
| **Partner ID** | Computed from seat ID | Explicit in command |
| **Relay targets** | 1 partner + N continues | N targets uniform |
| **Flow mode** | Per-seat | Per-target |
| **Trust model** | Asymmetric (odd/even roles) | Symmetric (any initiates) |
| **Challenges** | 1 per session | 1 per target per seat |
| **Signatures** | 1 per answer | 1 per target per answer |
| **Session selection** | Odd creates, even joins | Either creates or joins |
| **Event file** | Single eventsPath | eventsPath per target |

---

## Data Structure Examples

### v5: Trust State
```javascript
this.trustState = {
  challenge: "abc123def456...",
  peerPublicKey: "-----BEGIN PUBLIC KEY-----...",
  phase: "paired",  // "waiting_for_peer_signature" | "waiting_for_pair_ack" | "paired"
  pairedAt: "2025-03-15T20:30:00Z"
}
```

### v6: Target-Keyed Trust
```javascript
this.targetChallenges = {
  2: "abc123def456...",
  3: "ghi789jkl012...",
  5: "mno345pqr678..."
}

this.targetKeys = {
  2: "-----BEGIN PUBLIC KEY-----...",
  3: "-----BEGIN PUBLIC KEY-----...",
  5: "-----BEGIN PUBLIC KEY-----..."
}
```

