/**
 * Minimal Server-Sent Events parser (WHATWG EventSource wire format).
 *
 * `feed(chunk)` accepts arbitrary text chunks and returns every complete event
 * decoded so far. It supports:
 * - CRLF and LF line endings, including split CRLF across chunks;
 * - comment frames (`: heartbeat ...`) which are ignored;
 * - `event`, `id`, `retry` and multi-line `data` fields;
 * - blank-line event separation.
 *
 * The parser is deliberately dependency-free so the same logic can back the
 * CLI subscriber and be unit tested without a network.
 */
export function createSseParser() {
  let buffer = '';

  function feed(chunk) {
    buffer += String(chunk).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const events = [];
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const event = parseBlock(block);
      if (event) events.push(event);
      separator = buffer.indexOf('\n\n');
    }
    return events;
  }

  return {
    feed,
    /** Unparsed tail (useful for diagnostics/tests). */
    get pending() {
      return buffer;
    },
  };
}

function parseBlock(block) {
  let event = 'message';
  let id;
  let retry;
  const dataLines = [];
  let sawField = false;

  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value;
      sawField = true;
    } else if (field === 'id') {
      id = value;
      sawField = true;
    } else if (field === 'retry') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
      sawField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    }
  }

  if (!sawField && dataLines.length === 0) return null;
  const parsed = { event, data: dataLines.join('\n') };
  if (id !== undefined) parsed.id = id;
  if (retry !== undefined) parsed.retry = retry;
  return parsed;
}
