const DEFAULT_BODY_LIMIT = 8192;

export async function readBody(request, limit = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return { tooLarge: true, text: '' };
    chunks.push(chunk);
  }
  return { tooLarge: false, text: Buffer.concat(chunks).toString('utf8') };
}

/** Reads a login/logout body as JSON or form data; never logs its contents. */
export async function readCredentials(request) {
  const body = await readBody(request);
  if (body.tooLarge) return { error: 413 };
  if (!body.text) return { value: {} };
  const contentType = String(request.headers['content-type'] || '');
  try {
    if (contentType.includes('application/json')) {
      const parsed = JSON.parse(body.text);
      return parsed && typeof parsed === 'object'
        ? { value: parsed }
        : { error: 400 };
    }
    return { value: Object.fromEntries(new URLSearchParams(body.text)) };
  } catch {
    return { error: 400 };
  }
}
