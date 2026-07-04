import { useEffect, useRef, useState, useCallback } from 'react';

const API_BASE = 'http://localhost:4000';
const WS_URL = 'ws://localhost:4000';

function newRequestId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function App() {
  const [containers, setContainers] = useState({});
  const [shipments, setShipments] = useState({});
  // shipmentId -> { containerId, pending: true }  (this client's optimistic guess)
  const [optimisticPlacement, setOptimisticPlacement] = useState({});
  // shipmentId -> true  (locked by ANOTHER client, grey it out for us)
  const [lockedByOther, setLockedByOther] = useState({});
  // shipmentId -> true  (currently playing the rejection animation)
  const [snapBack, setSnapBack] = useState({});
  const [conflictLog, setConflictLog] = useState([]);
  const wsRef = useRef(null);

  // ---------------------------------------------------------------
  // Rollback helper — the ONE place that undoes an optimistic move.
  // Called from either the fetch rejection (fast STATE_CONFLICT) or
  // the WebSocket ASSIGN_REJECTED broadcast (slow CAPACITY_EXCEEDED).
  // Idempotent: if the shipment isn't optimistically placed anymore,
  // this is a no-op.
  // ---------------------------------------------------------------
  const rollback = useCallback((shipmentId) => {
    setOptimisticPlacement((prev) => {
      if (!prev[shipmentId]) return prev;
      const next = { ...prev };
      delete next[shipmentId];
      return next;
    });
    setSnapBack((prev) => ({ ...prev, [shipmentId]: true }));
    setLockedByOther((prev) => {
      if (!prev[shipmentId]) return prev;
      const next = { ...prev };
      delete next[shipmentId];
      return next;
    });
    setTimeout(() => {
      setSnapBack((prev) => {
        const next = { ...prev };
        delete next[shipmentId];
        return next;
      });
    }, 500); // matches the CSS animation duration
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/state`)
      .then((r) => r.json())
      .then((data) => {
        setContainers(data.containers);
        setShipments(data.shipments);
      })
      .catch(() => {});

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'INIT_STATE') {
        setContainers(msg.containers);
        setShipments(msg.shipments);
      }

      if (msg.type === 'SHIPMENT_LOCKED') {
        // Someone (possibly us) just won the lock. If it's not already
        // sitting in OUR optimistic view, grey it out so nobody else
        // can start dragging a shipment that's already spoken for.
        setLockedByOther((prev) => ({ ...prev, [msg.shipmentId]: true }));
      }

      if (msg.type === 'ASSIGN_COMMITTED') {
        setContainers((prev) => ({
          ...prev,
          [msg.containerId]: {
            ...prev[msg.containerId],
            currentWeight: msg.currentWeight,
            shipmentIds: [...(prev[msg.containerId]?.shipmentIds || []), msg.shipmentId],
          },
        }));
        setShipments((prev) => ({
          ...prev,
          [msg.shipmentId]: { ...prev[msg.shipmentId], status: 'PLACED' },
        }));
        setOptimisticPlacement((prev) => {
          const next = { ...prev };
          delete next[msg.shipmentId];
          return next;
        });
        setLockedByOther((prev) => {
          const next = { ...prev };
          delete next[msg.shipmentId];
          return next;
        });
      }

      if (msg.type === 'ASSIGN_REJECTED') {
        rollback(msg.shipmentId);
      }
    };

    return () => ws.close();
  }, [rollback]);

  const handleDrop = (shipmentId, containerId) => {
    const shipment = shipments[shipmentId];
    if (!shipment || shipment.status !== 'AVAILABLE') return;
    if (optimisticPlacement[shipmentId] || lockedByOther[shipmentId]) return;

    const requestId = newRequestId();

    // 1) OPTIMISTIC UPDATE — happens instantly, before the network call.
    setOptimisticPlacement((prev) => ({ ...prev, [shipmentId]: { containerId, pending: true } }));

    // 2) Fire the real request. The 2.5s validation delay lives entirely
    //    on the server; the UI never blocks waiting for it.
    fetch(`${API_BASE}/api/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentId, containerId, requestId }),
    })
      .then(async (res) => {
        if (res.status === 409) {
          const body = await res.json();
          if (body.error === 'STATE_CONFLICT') {
            setConflictLog((prev) => [
              {
                shipmentId,
                containerId,
                ...body,
                receivedAt: new Date().toLocaleTimeString(),
              },
              ...prev,
            ].slice(0, 6));
          }
          rollback(shipmentId);
        }
        // success and CAPACITY_EXCEEDED are both resolved via the
        // WebSocket broadcast (ASSIGN_COMMITTED / ASSIGN_REJECTED),
        // which every tab — including this one — receives.
      })
      .catch(() => rollback(shipmentId));
  };

  const availableShipments = Object.values(shipments).filter(
    (s) => s.status === 'AVAILABLE' && !optimisticPlacement[s.id]
  );

  return (
    <div className="app">
      <header>
        <h1>Collision-Agile Dynamic Workspace</h1>
        <p className="subtitle">Drag shipments into a container. The server takes 2.5s to validate every move.</p>
      </header>

      <div className="board">
        <section className="available-panel">
          <h2>Available Shipments</h2>
          <div className="shipment-list">
            {availableShipments.map((s) => (
              <div
                key={s.id}
                className={`shipment-chip ${lockedByOther[s.id] ? 'locked-other' : ''} ${snapBack[s.id] ? 'snap-back' : ''}`}
                draggable={!lockedByOther[s.id]}
                onDragStart={(e) => e.dataTransfer.setData('text/plain', s.id)}
              >
                <span>{s.label}</span>
                <span className="weight-badge">{s.weight}kg</span>
                {lockedByOther[s.id] && <span className="lock-tag">locked by another user…</span>}
              </div>
            ))}
            {availableShipments.length === 0 && <p className="empty">All shipments placed.</p>}
          </div>
        </section>

        <section className="containers-panel">
          {Object.values(containers).map((container) => {
            const pendingIds = Object.entries(optimisticPlacement)
              .filter(([, p]) => p.containerId === container.id)
              .map(([id]) => id);
            const pendingWeight = pendingIds.reduce((sum, id) => sum + (shipments[id]?.weight || 0), 0);
            const displayedWeight = container.currentWeight + pendingWeight;
            const overCapacity = displayedWeight > container.maxWeight;

            return (
              <div
                key={container.id}
                className={`container-slot ${overCapacity ? 'over-capacity' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const shipmentId = e.dataTransfer.getData('text/plain');
                  handleDrop(shipmentId, container.id);
                }}
              >
                <div className="container-header">
                  <h3>Container {container.id}</h3>
                  <span className="capacity">
                    {displayedWeight} / {container.maxWeight}kg
                  </span>
                </div>
                <div className="capacity-bar">
                  <div
                    className="capacity-fill"
                    style={{ width: `${Math.min(100, (displayedWeight / container.maxWeight) * 100)}%` }}
                  />
                </div>
                <div className="container-items">
                  {container.shipmentIds.map((id) => (
                    <div key={id} className="shipment-chip placed">
                      <span>{shipments[id]?.label}</span>
                      <span className="weight-badge">{shipments[id]?.weight}kg</span>
                    </div>
                  ))}
                  {pendingIds.map((id) => (
                    <div key={id} className="shipment-chip pending">
                      <span>{shipments[id]?.label}</span>
                      <span className="weight-badge">{shipments[id]?.weight}kg</span>
                      <span className="pending-tag">validating…</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      </div>

      {conflictLog.length > 0 && (
        <section className="conflict-log">
          <h2>State Conflict Log</h2>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Shipment</th>
                <th>Container</th>
                <th>Collision (ms)</th>
                <th>Capacity Missed</th>
                <th>Compute Waste (ms)</th>
              </tr>
            </thead>
            <tbody>
              {conflictLog.map((c, i) => (
                <tr key={i}>
                  <td>{c.receivedAt}</td>
                  <td>{c.shipmentId}</td>
                  <td>{c.containerId}</td>
                  <td>{c.collisionTimestampMs}</td>
                  <td>{c.fractionalCapacityMissedKg}kg</td>
                  <td>{c.computeWasteMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
