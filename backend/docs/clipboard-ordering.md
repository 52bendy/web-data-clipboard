# Clipboard ordering and multi-device conflict policy (defect 23)

This document defines how the network clipboard decides what "latest" means
when reports arrive from multiple devices whose clocks may be wrong or
malicious. It complements the public contract in
[clipboard-api.md](clipboard-api.md).

## Authoritative clock: `received_at`

`createClipboardStore().write()` assigns `received_at` **inside the atomic
per-key update**, at the same moment it assigns the server sequence number
`seq`. It also mirrors the value to `updated_at` so the PRD §4.1.2 read
contract remains unchanged.

```
client report                 server clipboard record
-------------                 -----------------------
timestamp: 1728950400000  ->  client_timestamp: 1728950400000  (reference)
                              received_at:      "<server commit time>"
                              updated_at:       "<same value>"
                              seq:              1, 2, 3, ...
```

Rules:

- `received_at` is the only input for latest-record ordering, TTL, `ETag`,
  `Last-Modified`, `?updated_after=` and dashboard display.
- `client_timestamp` is validated as a non-negative integer when present and
  stored for audit/reference only. It is never compared with another device's
  timestamp and never affects which record is latest.
- Client-supplied `clipboard_id`, `seq` or `updated_at` values are ignored.

## Multi-device conflict policy: last arrival wins

There is no "largest timestamp wins" or content merge. The write that commits
last at the server becomes the latest record:

1. Each accepted report calls `storage.update('clipboard:latest', ...)`.
   The storage adapter serializes read-modify-write cycles per key (the memory
   adapter uses a promise chain; the Upstash adapter uses a distributed lock).
2. The updater receives the current record and returns the new record with
   `seq = previous.seq + 1`.
3. The last update to commit is what `getLatest()` returns. This is the
   **last-arrival-wins** semantics referenced by defect 23.
4. Every accepted write is also appended to the bounded history log. The
   history entry carries an `overwrote` snapshot:

```json
{
  "clipboard_id": "…",
  "received_at": "2026-10-17T12:00:01.000Z",
  "updated_at": "2026-10-17T12:00:01.000Z",
  "client_timestamp": 1728950399000,
  "seq": 2,
  "overwrote": {
    "clipboard_id": "…",
    "seq": 1,
    "received_at": "2026-10-17T12:00:00.000Z"
  }
}
```

`getHistory()` orders entries by server receive time, then by `seq` as a
tie-breaker, so a delayed history append cannot reorder the audit trail.

## Worked examples

### Device clock is 10 minutes slow

| Event                              | Server receive time | Device timestamp | Result          |
| ---------------------------------- | ------------------- | ---------------- | --------------- |
| Device A reports code 111111       | 12:00:00            | 11:50:00         | latest, `seq=1` |
| Device B reports code 222222       | 12:00:01            | 12:00:01         | latest, `seq=2` |
| Device A reports stale code 333333 | 12:00:02            | 11:50:02         | latest, `seq=3` |

The stale device still wins **because its report arrived last**, not because
of its clock. If the product intent is "ignore stale content", that is a
separate content-freshness policy; the clipboard deliberately does not guess
from untrusted clocks.

### Two devices report within the same second

Both writes serialize on the clipboard key. The second commit gets the higher
`seq` and becomes latest; both records remain in history with the overwrite
chain intact. The outcome is deterministic with respect to server commit
order, not to either device's clock.

### TTL expires

When the latest record expires, `getLatest()` returns `null`. The next write
starts a new generation at `seq=1` and `overwrote=null`; retained history
entries from the previous generation are not used to order the new record.

## Verification

`backend/test/clipboard-store.test.js` covers:

- client-supplied ids/timestamps are ignored and `client_timestamp` is stored;
- a slow/fast device clock cannot change latest ordering;
- 50 concurrent writes produce unique `seq` values, a clean latest record and
  a complete history;
- every history entry records the `overwrote` snapshot of its predecessor;
- history is sorted by server time even if storage order is perturbed.

`backend/test/clipboard-latest.test.js` verifies that API timing/ETag logic
prefers `received_at` over a forged/legacy `updated_at`.
