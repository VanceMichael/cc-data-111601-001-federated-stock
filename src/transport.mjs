export async function acquire(base, path, options = {}) {
  const { headers = {}, method, body } = options;
  const origin = new URL(base);
  const target = new URL(path, origin);
  if (target.origin !== origin.origin) throw new Error('outside_source');
  const request = { headers: { ...headers }, redirect: 'error', signal: AbortSignal.timeout(5000) };
  if (body !== undefined) {
    request.method = method ?? 'POST';
    request.body = typeof body === 'string' ? body : JSON.stringify(body);
    request.headers['content-type'] = 'application/json';
  } else if (method) request.method = method;
  const response = await fetch(target, request);
  if (!response.ok) throw new Error(`source_status_${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('source_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), headers: Object.fromEntries(response.headers), status: response.status };
}
