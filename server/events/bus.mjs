/**
 * Domain event bus and SSE fan-out.
 *
 * Broadcasts are project-scoped. Switching projects closes the old streams in
 * the browser, and a late event from the old project is dropped here because
 * the stream is bound to the ctx id it was opened with.
 */

import { initSse, sendSse } from "../http/respond.mjs";

export function sendToClient(res, payload) {
  return sendSse(res, payload);
}

export function createEventBus() {
  const globalClients = new Map();
  const listeners = new Set();

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function publish(payload, projectId = null) {
    for (const listener of [...listeners]) {
      try {
        listener(payload, projectId);
      } catch {
        /* a bad listener must not break other broadcasts */
      }
    }
    return broadcastGlobal(payload, projectId);
  }

  function broadcastGlobal(payload, projectId = null) {
    let delivered = 0;
    for (const [res, id] of globalClients) {
      if (projectId && id !== projectId) continue;
      if (sendToClient(res, payload)) delivered += 1;
    }
    return delivered;
  }

  function broadcast(entry, payload) {
    let delivered = 0;
    for (const res of entry.clients) {
      if (sendToClient(res, payload)) delivered += 1;
    }
    return delivered;
  }

  function openGlobal(req, res, ctx) {
    initSse(res);
    globalClients.set(res, ctx.id);
    sendToClient(res, { type: "hello", projectId: ctx.id });
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* client disappeared */
      }
    }, 15000);
    ping.unref?.();
    req.on("close", () => {
      clearInterval(ping);
      globalClients.delete(res);
    });
  }

  function openSession(req, res, entry) {
    initSse(res);
    entry.clients.add(res);
    sendToClient(res, entry.snapshot());
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* client disappeared */
      }
    }, 15000);
    ping.unref?.();
    req.on("close", () => {
      clearInterval(ping);
      entry.clients.delete(res);
    });
  }

  function close() {
    globalClients.clear();
    listeners.clear();
  }

  return {
    subscribe,
    publish,
    broadcast,
    broadcastGlobal,
    openGlobal,
    openSession,
    close,
    get globalClientCount() {
      return globalClients.size;
    },
  };
}
