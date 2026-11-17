import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, CollectionStore } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect, representationKey } from './reader.mjs';
import { parseCatalog, parseSchema, createCollection, applyPrimary, planClaims, applyClaim,
  markClaimFailed, recordRequest, view, summarize, outstanding } from './collector.mjs';

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  if (length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function claimRound(source, store, collection) {
  for (const claim of planClaims(collection)) {
    const at = new Date().toISOString();
    const targets = claim.representations.map(representation =>
      representationKey({ type: representation.__typename, key: representation.key }));
    try {
      const result = await acquire(source, claim.path,
        { body: { representations: claim.representations, fields: claim.fields } });
      const digest = await store.stash(result.bytes);
      let payload = null;
      try { payload = JSON.parse(result.bytes.toString('utf8')); } catch { payload = null; }
      const requestId = recordRequest(collection, { service: claim.service, path: claim.path, method: 'POST',
        outcome: 'ok', fields: claim.fields, representations: targets, digest,
        ...(Array.isArray(payload?.errors) && payload.errors.length ? { errors: payload.errors } : {}) });
      applyClaim(collection, claim, payload, requestId, at);
    } catch (error) {
      const requestId = recordRequest(collection, { service: claim.service, path: claim.path, method: 'POST',
        outcome: 'failed', fields: claim.fields, representations: targets, error: error.message });
      markClaimFailed(collection, claim, requestId, at, error.message);
    }
  }
}

async function openCollection(source, store, body) {
  const catalogResult = await acquire(source, '/catalog');
  const catalog = parseCatalog(catalogResult.bytes);
  const entry = body.path ?? catalog.entry;
  const schemaResult = await acquire(source, catalog.ownership);
  const ownership = parseSchema(schemaResult.bytes);
  const primaryResult = await acquire(source, entry);
  const parsed = inspect(primaryResult.bytes);
  const collection = createCollection({ id: randomUUID(), source, entry, ownership,
    services: catalog.services, products: parsed.products, fields: body.fields,
    at: new Date().toISOString() });
  recordRequest(collection, { service: 'catalog', path: '/catalog', method: 'GET', outcome: 'ok',
    digest: await store.stash(catalogResult.bytes) });
  recordRequest(collection, { service: 'schema', path: catalog.ownership, method: 'GET', outcome: 'ok',
    digest: await store.stash(schemaResult.bytes) });
  const primaryId = recordRequest(collection, { service: 'products', path: entry, method: 'GET', outcome: 'ok',
    digest: await store.stash(primaryResult.bytes),
    ...(parsed.errors?.length ? { errors: parsed.errors } : {}) });
  applyPrimary(collection, parsed.products, primaryId, new Date().toISOString());
  return collection;
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const collections = await new CollectionStore(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/collections' && request.method === 'POST') {
        const body = await readJson(request);
        if (body.path !== undefined && typeof body.path !== 'string') throw new Error('path_invalid');
        const collection = await openCollection(source, store, body);
        await claimRound(source, store, collection);
        await collections.save(collection);
        response.statusCode = 201;
        return response.end(JSON.stringify(view(collection)));
      }
      if (url.pathname === '/collections' && request.method === 'GET') {
        return response.end(JSON.stringify((await collections.list()).map(summarize)));
      }
      const collectionMatch = /^\/collections\/([0-9a-f-]{36})(\/claims|\/outstanding)?$/.exec(url.pathname);
      if (collectionMatch) {
        const [, id, suffix] = collectionMatch;
        const collection = await collections.get(id);
        if (!collection) {
          response.writeHead(404);
          return response.end(JSON.stringify({ error: 'unknown_collection' }));
        }
        if (!suffix && request.method === 'GET') return response.end(JSON.stringify(view(collection)));
        if (suffix === '/outstanding' && request.method === 'GET')
          return response.end(JSON.stringify({ id, outstanding: outstanding(collection) }));
        if (suffix === '/claims' && request.method === 'POST') {
          await claimRound(source, store, collection);
          await collections.save(collection);
          return response.end(JSON.stringify(view(collection)));
        }
        response.writeHead(404);
        return response.end(JSON.stringify({ error: 'not_found' }));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, collections, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
