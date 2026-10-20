/**
 * Public CopilotKit Core subscriptions.
 *
 * Core-level subscribers cover runtime status, errors, agent discovery and
 * frontend tool execution. The Core-managed agent's public `subscribe` covers
 * the AG-UI stream that carries backend (Pi) tool calls and text. No ɵ export
 * is used.
 */

export function attachCoreSubscriptions(core, handlers = {}) {
  return core.subscribe({
    onRuntimeConnectionStatusChanged: ({ status }) => handlers.onConnectionStatus?.(status),
    onAgentsChanged: ({ agents }) => handlers.onAgentsChanged?.(agents),
    onToolExecutionStart: (event) => handlers.onToolExecutionStart?.(event),
    onToolExecutionEnd: (event) => handlers.onToolExecutionEnd?.(event),
    onError: ({ error, code, context }) => handlers.onError?.(error, code, context),
  });
}

export function attachAgentSubscriptions(core, agent, handlers = {}) {
  const lifecycle = core.subscribeToAgentWithOptions(agent, {
    onMessagesChanged: (params) => handlers.onMessagesChanged?.(params),
    onStateChanged: (params) => handlers.onStateChanged?.(params),
    onRunInitialized: (params) => handlers.onRunInitialized?.(params),
    onRunFinalized: (params) => handlers.onRunFinalized?.(params),
    onRunFailed: (params) => handlers.onRunFailed?.(params),
    onRunErrorEvent: (params) => handlers.onRunErrorEvent?.(params),
  }, { throttleMs: 0 });

  const events = agent.subscribe({
    onRunStartedEvent: (params) => handlers.onRunStartedEvent?.(params),
    onTextMessageStartEvent: (params) => handlers.onTextMessageStartEvent?.(params),
    onTextMessageContentEvent: (params) => handlers.onTextMessageContentEvent?.(params),
    onTextMessageEndEvent: (params) => handlers.onTextMessageEndEvent?.(params),
    onToolCallStartEvent: (params) => handlers.onToolCallStartEvent?.(params),
    onToolCallArgsEvent: (params) => handlers.onToolCallArgsEvent?.(params),
    onToolCallEndEvent: (params) => handlers.onToolCallEndEvent?.(params),
    onToolCallResultEvent: (params) => handlers.onToolCallResultEvent?.(params),
    onRunFinishedEvent: (params) => handlers.onRunFinishedEvent?.(params),
    onRunErrorEvent: (params) => handlers.onRunErrorEvent?.(params),
  });

  return {
    unsubscribe() {
      try {
        lifecycle.unsubscribe();
      } catch {
        /* already detached */
      }
      try {
        events.unsubscribe();
      } catch {
        /* already detached */
      }
    },
  };
}
