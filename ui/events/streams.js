/**
 * EventSource lifecycle.
 *
 * Both streams are bound to the project and (for the agent stream) the session
 * that opened them. A late event from a previous project/session is dropped
 * before it can touch the new state.
 */

import { getState } from "../state/store.js";
import { withProject } from "../api/client.js";

let globalStream = null;
let agentStream = null;

export function closeGlobalStream() {
  if (globalStream) {
    globalStream.close();
    globalStream = null;
    getState().globalEs = null;
  }
}

export function closeAgentStream() {
  if (agentStream) {
    agentStream.close();
    agentStream = null;
    getState().es = null;
  }
}

export function closeStreams() {
  closeGlobalStream();
  closeAgentStream();
}

export function openGlobalStream(onEvent, { onError = () => {} } = {}) {
  closeGlobalStream();
  const projectId = getState().project?.id;
  const stream = new EventSource(withProject("/api/events"));
  globalStream = stream;
  getState().globalEs = stream;
  stream.onmessage = (event) => {
    if (getState().project?.id !== projectId) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    onEvent(payload);
  };
  stream.onerror = onError;
  return stream;
}

export function openAgentStream(sessionId, onEvent, { onError = () => {} } = {}) {
  closeAgentStream();
  const projectId = getState().project?.id;
  const stream = new EventSource(withProject(`/api/sessions/${encodeURIComponent(sessionId)}/events`));
  agentStream = stream;
  getState().es = stream;
  stream.onmessage = (event) => {
    if (getState().project?.id !== projectId) return;
    if (getState().activeSession !== sessionId) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    onEvent(payload);
  };
  stream.onerror = onError;
  return stream;
}
