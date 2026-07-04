/**
 * WARP DASHBOARD BACKEND
 * ------------------------------------------------------------------
 * This server intentionally uses ZERO external lock/queue libraries.
 * The "lock" is nothing more than a plain JS object we check and set
 * synchronously. That works because Node's event loop guarantees that
 * synchronous code in one request handler cannot be interrupted by
 * another request's synchronous code — the interleaving only happens
 * once we hit an async boundary (our setTimeout below, standing in
 * for real validation/DB work). So the "critical section" is exactly
 * the few lines between reading the lock and writing it.
 * ------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PROCESSING_DELAY_MS = 2500;

// ---------------------------------------------------------------
// In-memory "database"
// ---------------------------------------------------------------
const CONTAINERS = {
  A: { id: 'A', maxWeight: 500, currentWeight: 0, shipmentIds: [] },
  B: { id: 'B', maxWeight: 500, currentWeight: 0, shipmentIds: [] },
  C: { id: 'C', maxWeight: 500, currentWeight: 0, shipmentIds: [] },
};

const SHIPMENTS = {
  s1: { id: 's1', label: 'Shipment #101', weight: 120, status: 'AVAILABLE' },
  s2: { id: 's2', label: 'Shipment #102', weight: 90, status: 'AVAILABLE' },
  s3: { id: 's3', label: 'Shipment #103', weight: 210, status: 'AVAILABLE' },
  s4: { id: 's4', label: 'Shipment #104', weight: 60, status: 'AVAILABLE' },
  s5: { id: 's5', label: 'Shipment #105', weight: 300, status: 'AVAILABLE' },
  s6: { id: 's6', label: 'Shipment #106', weight: 150, status: 'AVAILABLE' },
  s7: { id: 's7', label: 'Shipment #107', weight: 45, status: 'AVAILABLE' },
  s8: { id: 's8', label: 'Shipment #108', weight: 180, status: 'AVAILABLE' },
};

// ---------------------------------------------------------------
// The lock tables. Two of them, on purpose:
//   containerLocks -> stops two different shipments racing for the
//                      same container slot at the same millisecond
//   shipmentLocks   -> stops the SAME shipment being dropped into two
//                      different containers at the same millisecond
// Both are just plain objects. No Redis, no DB row locking.
// ---------------------------------------------------------------
const containerLocks = { A: null, B: null, C: null };
const shipmentLocks = {}; // shipmentId -> { requestId, lockedAt, containerId }

function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

/**
 * POST /api/assign
 * body: { shipmentId, containerId, requestId }
 *
 * Flow:
 *   1. SYNCHRONOUS gate — acquire both locks or reject immediately
 *      with a State Conflict payload (this is the part that resolves
 *      the "two tabs, same millisecond" race).
 *   2. ASYNC validation — wait 2.5s (stand-in for real business
 *      logic / DB writes), then check the actual weight capacity,
 *      commit or reject, release locks, and tell everyone over the
 *      socket.
 */
app.post('/api/assign', (req, res) => {
  const { shipmentId, containerId, requestId } = req.body || {};
  const receivedAt = Date.now();

  const shipment = SHIPMENTS[shipmentId];
  const container = CONTAINERS[containerId];

  if (!shipment || !container || !requestId) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'shipmentId, containerId and requestId are required.' });
  }

  if (shipment.status !== 'AVAILABLE') {
    return res.status(409).json({ error: 'SHIPMENT_ALREADY_PLACED', shipmentId });
  }

  // --- CRITICAL SECTION (fully synchronous, cannot be interleaved) ---
  const existingShipmentLock = shipmentLocks[shipmentId];
  const existingContainerLock = containerLocks[containerId];

  if (existingShipmentLock || existingContainerLock) {
    const collidedWith = existingShipmentLock || existingContainerLock;
    const collisionTimestampMs = receivedAt;
    const computeWasteMs = collisionTimestampMs - collidedWith.lockedAt; // time already spent on the winning request
    const fractionalCapacityMissedKg = Math.min(
      shipment.weight,
      Math.max(0, container.maxWeight - container.currentWeight)
    );

    return res.status(409).json({
      error: 'STATE_CONFLICT',
      collisionTimestampMs,
      collidedWithRequestId: collidedWith.requestId,
      fractionalCapacityMissedKg,
      computeWasteMs,
      message: `Rejected: ${existingShipmentLock ? 'shipment' : 'container'} was already locked by request ${collidedWith.requestId} ${computeWasteMs}ms earlier.`,
    });
  }

  // Acquire both locks atomically-in-spirit (still just sync assignment)
  const lockInfo = { requestId, lockedAt: receivedAt, containerId };
  shipmentLocks[shipmentId] = lockInfo;
  containerLocks[containerId] = lockInfo;
  // --- END CRITICAL SECTION ---

  // Let everyone else know this shipment is now spoken for, so their
  // UIs can grey it out / cancel an in-flight drag immediately —
  // without waiting for the full 2.5s validation to finish.
  broadcast({ type: 'SHIPMENT_LOCKED', shipmentId, containerId, requestId });

  setTimeout(() => {
    const fits = container.currentWeight + shipment.weight <= container.maxWeight;

    if (fits) {
      container.currentWeight += shipment.weight;
      container.shipmentIds.push(shipmentId);
      shipment.status = 'PLACED';

      broadcast({ type: 'ASSIGN_COMMITTED', shipmentId, containerId, requestId, currentWeight: container.currentWeight });
      res.json({ success: true, shipmentId, containerId, currentWeight: container.currentWeight });
    } else {
      broadcast({ type: 'ASSIGN_REJECTED', shipmentId, containerId, requestId, reason: 'CAPACITY_EXCEEDED' });
      res.status(409).json({
        error: 'CAPACITY_EXCEEDED',
        shipmentId,
        containerId,
        currentWeight: container.currentWeight,
        maxWeight: container.maxWeight,
        attemptedWeight: shipment.weight,
      });
    }

    // Release both locks regardless of outcome
    delete shipmentLocks[shipmentId];
    if (containerLocks[containerId] && containerLocks[containerId].requestId === requestId) {
      containerLocks[containerId] = null;
    }
  }, PROCESSING_DELAY_MS);
});

app.get('/api/state', (req, res) => {
  res.json({ containers: CONTAINERS, shipments: SHIPMENTS });
});

// Push full state on connect so a fresh tab doesn't have to guess
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'INIT_STATE', containers: CONTAINERS, shipments: SHIPMENTS }));
});

const PORT = 4000;
server.listen(PORT, () => console.log(`Warp dashboard backend listening on http://localhost:${PORT}`));
