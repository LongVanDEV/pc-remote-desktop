# Signaling

Rooms are named `room-<deviceId>`.

| Type | Direction | Purpose |
|------|-----------|--------|
| `offer` | viewer → host | Start session |
| `answer` | host → viewer | Accept |
| `ice` | both | Candidates |
| `bye` | both | Hang up |

All payloads should be schema-validated in production.
