/**
 * Structured JSON-line logger. One line per event, machine-readable, so the
 * collect chain (auth → validation → extraction → clipboard → dispatch) can
 * be traced end-to-end by `collection_id` in platform logs (REQ-202610-1253).
 */
export function createLogger({ sink = console, now = Date.now } = {}) {
  const emit = (level, event, fields) =>
    sink.log(
      JSON.stringify({
        ts: new Date(now()).toISOString(),
        level,
        event,
        ...fields,
      }),
    );
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export const logger = createLogger();
