# Collision-Agile Dynamic Workspace

## Run it

```bash
# Terminal 1
cd backend
npm install
npm start        # http://localhost:4000

# Terminal 2
cd frontend
npm install
npm run dev       # http://localhost:5173
```

Open two browser tabs at `http://localhost:5173` to actually see the race
condition and cross-tab sync in action.

## How the three hard requirements are solved

### 1. Optimistic UI + snap-back (`frontend/src/App.jsx`)
`handleDrop` updates `optimisticPlacement` **synchronously**, before the
`fetch` call even leaves the browser. The shipment renders inside the
container immediately, marked "validating…". The actual POST resolves
2.5s later (server-side `setTimeout`). If it comes back rejected — either
instantly (`STATE_CONFLICT`) or after the delay (`CAPACITY_EXCEEDED`) — the
single `rollback()` function removes the optimistic entry and adds a
`snap-back` CSS class that plays a short shake/flash animation as the chip
reappears in the Available list. No page reload, no blocked input.

### 2. Custom in-memory lock, no Redis/DB locks (`backend/server.js`)
`containerLocks` and `shipmentLocks` are plain objects. The trick is
**where** the check-and-set happens: entirely inside synchronous code, with
no `await`/async gap between reading the lock and writing it. Node's event
loop can't interleave two requests' synchronous code, so that check-and-set
is a real mutex even without any library. The lock is only released inside
the `setTimeout` callback, so a second request arriving during the 2.5s
window is rejected on the spot with the millisecond timestamp, the fractional
capacity it missed, and how much time was already burned on the winning
request (`computeWasteMs`).

Two locks, not one, because there are two distinct races in the spec:
container-level (two shipments racing for the same slot) and shipment-level
(the same shipment dragged into two different containers at once).

### 3. Real-time sync (`ws`, both sides)
The server broadcasts three events: `SHIPMENT_LOCKED` (fires the instant a
lock is acquired, well before the 2.5s validation finishes — this is what
lets other tabs grey out a shipment mid-drag), `ASSIGN_COMMITTED`, and
`ASSIGN_REJECTED`. Every tab, including the one that initiated the action,
treats the socket as the single source of truth for committed state; the
fetch response is only used to trigger the fast-path rollback for
`STATE_CONFLICT` (which never reaches the WebSocket, since the loser never
acquires a lock in the first place).

## Known simplifications (worth saying out loud in the interview)
- Locks are per-process memory — fine for one Node instance, would need a
  shared store (e.g. Redis, but a real distributed lock, not just "a locker
  package") if this ran on multiple server instances.
- No auth/user identity — "User A / User B" is really "tab A / tab B".
- Drag-and-drop uses native HTML5 DnD, not `react-dnd`, to keep the
  dependency list honest for a take-home.
