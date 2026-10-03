# Architecture

## Components

1. **Host** — captures display, encodes, publishes presence
2. **Viewer** — receives media, sends input
3. **Signal plane** — SDP / ICE exchange
4. **Cloud API** — devices, invites, bans, announcements

## Trust boundaries

- Host trusts authenticated viewers only after pairing or invite redeem
- Signaling messages are validated before affecting WebRTC state
- Media path is peer-to-peer when possible; TURN is fallback

## Public vs private

This repository documents the *shape* of the system.
Production capture pipelines and proprietary optimizations are not included here.
