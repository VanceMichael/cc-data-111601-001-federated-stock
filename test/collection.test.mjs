import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function sandbox() {
  const directory = await mkdtemp(join(tmpdir(), 'collection-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  return { directory, provider, service,
    async close() { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('按字段领取：部分收齐、空值与临时失败分明、每个值可追溯到请求', async () => {
  const { service, close } = await sandbox();
  try {
    const created = await postJson(`${service.url}/collections`, { fields: ['name', 'stock'] });
    assert.equal(created.status, 201);
    const collection = created.body;
    assert.equal(collection.complete, false);
    const blue = collection.entities.find(entity => entity.key.variant === 'blue');
    const red = collection.entities.find(entity => entity.key.variant === 'red');
    assert.equal(blue.complete, true);
    assert.equal(red.complete, false);
    assert.equal(blue.fields.name.status, 'confirmed');
    assert.equal(blue.fields.name.value, '训练器');
    assert.equal(blue.fields.stock.status, 'confirmed');
    assert.deepEqual(blue.fields.stock.value, { north: 4, south: null });
    assert.equal(red.fields.stock.status, 'temporary');
    assert.equal(red.fields.stock.lastError.code, 'TEMPORARY');
    assert.ok(!('value' in red.fields.stock));
    assert.equal(collection.outstanding.length, 1);
    assert.equal(collection.outstanding[0].entity, red.id);
    assert.equal(collection.outstanding[0].field, 'stock');
    assert.equal(collection.outstanding[0].retriable, true);
    const nameRequest = collection.requests.find(request => request.id === blue.fields.name.origin.request);
    assert.equal(nameRequest.service, 'products');
    assert.equal(nameRequest.method, 'GET');
    const stockRequest = collection.requests.find(request => request.id === blue.fields.stock.origin.request);
    assert.equal(stockRequest.service, 'warehouses');
    assert.equal(stockRequest.method, 'POST');
    assert.deepEqual(stockRequest.fields, ['stock']);
    const echoed = JSON.parse(Buffer.from(await (await fetch(`${service.url}/objects/${stockRequest.digest}`))
      .arrayBuffer()).toString('utf8'));
    assert.equal(echoed.data.entities.length, 2);
    assert.equal(echoed.errors[0].code, 'TEMPORARY');
    const list = await (await fetch(`${service.url}/collections`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].entities, 2);
    assert.equal(list[0].outstanding, 1);
    assert.equal(list[0].complete, false);
  } finally { await close(); }
});

test('补领只领取未确认字段，来源恢复后收齐，重启后仍可查询', async () => {
  const { directory, provider, service, close } = await sandbox();
  try {
    const created = await postJson(`${service.url}/collections`, { fields: ['name', 'stock'] });
    const first = created.body;
    const redId = first.entities.find(entity => entity.key.variant === 'red').id;
    const blueId = first.entities.find(entity => entity.key.variant === 'blue').id;
    const again = await postJson(`${service.url}/collections/${first.id}/claims`, {});
    assert.equal(again.status, 200);
    let warehouses = again.body.requests.filter(request => request.service === 'warehouses');
    assert.equal(warehouses.length, 2);
    assert.deepEqual(warehouses[1].representations, [redId]);
    assert.deepEqual(warehouses[1].fields, ['stock']);
    const blueAfter = again.body.entities.find(entity => entity.id === blueId);
    assert.equal(blueAfter.fields.stock.origin.request, warehouses[0].id);
    assert.equal(again.body.entities.find(entity => entity.id === redId).fields.stock.status, 'temporary');
    await postJson(`${provider.url}/_phase`, { phase: 1 });
    const recovered = await postJson(`${service.url}/collections/${first.id}/claims`, {});
    assert.equal(recovered.body.complete, true);
    const red = recovered.body.entities.find(entity => entity.id === redId);
    assert.equal(red.fields.stock.status, 'confirmed');
    assert.deepEqual(red.fields.stock.value, { north: 0 });
    warehouses = recovered.body.requests.filter(request => request.service === 'warehouses');
    assert.equal(warehouses.length, 3);
    assert.equal(red.fields.stock.origin.request, warehouses[2].id);
    assert.deepEqual(recovered.body.outstanding, []);
    const outstandingView = await (await fetch(`${service.url}/collections/${first.id}/outstanding`)).json();
    assert.deepEqual(outstandingView.outstanding, []);
    await service.close();
    const reopened = await startService({ source: provider.url, directory });
    try {
      const fetched = await (await fetch(`${reopened.url}/collections/${first.id}`)).json();
      assert.equal(fetched.complete, true);
      assert.equal(fetched.entities.find(entity => entity.id === redId).fields.stock.status, 'confirmed');
      assert.equal(fetched.requests.length, recovered.body.requests.length);
    } finally { await reopened.close(); }
  } finally { await close(); }
});

test('默认计划覆盖配件字段：未匹配实体与无关无权错误不伪装空值', async () => {
  const { service, close } = await sandbox();
  try {
    const created = await postJson(`${service.url}/collections`, {});
    assert.equal(created.status, 201);
    const collection = created.body;
    const blue = collection.entities.find(entity => entity.key.variant === 'blue');
    const red = collection.entities.find(entity => entity.key.variant === 'red');
    for (const entity of [blue, red]) {
      assert.equal(entity.fields.accessories.status, 'missing');
      assert.equal(entity.fields.accessories.detail, 'no_matching_entity');
      assert.ok(!('value' in entity.fields.accessories));
    }
    const partsRequest = collection.requests.find(request => request.service === 'parts');
    assert.deepEqual(partsRequest.fields, ['accessories']);
    assert.equal(partsRequest.errors[0].code, 'FORBIDDEN');
    const summary = collection.outstanding.map(entry => `${entry.key.variant}:${entry.field}:${entry.status}`).sort();
    assert.deepEqual(summary, ['blue:accessories:missing', 'red:accessories:missing', 'red:stock:temporary']);
  } finally { await close(); }
});

test('空值、无权、临时、未知错误码与字段缺失互不混同，补领不重领已确认与无权字段', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collection-stub-'));
  const bodies = [];
  const stub = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/catalog') return response.end(JSON.stringify({ entry: '/primary', ownership: '/schema',
      services: { wh: '/wh' } }));
    if (url.pathname === '/schema') return response.end(JSON.stringify({
      Product: { name: 'products', stock: 'wh', price: 'wh', gone: 'wh', absent: 'wh', weird: 'wh' } }));
    if (url.pathname === '/primary') return response.end(JSON.stringify({ data: { products: [
      { __typename: 'Product', key: { model: 'X' }, fields: { name: 'x' } }] } }));
    if (url.pathname === '/wh' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return response.end(JSON.stringify({
        data: { entities: [{ __typename: 'Product', key: { model: 'X' }, fields: { stock: null } }] },
        errors: [
          { path: ['entities', 0, 'fields', 'price'], code: 'FORBIDDEN' },
          { path: ['entities', 0, 'fields', 'gone'], code: 'TEMPORARY' },
          { path: ['entities', 0, 'fields', 'weird'], code: 'QUOTA' },
        ] }));
    }
    response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const service = await startService({ source: `http://127.0.0.1:${stub.address().port}`, directory });
  try {
    const created = await postJson(`${service.url}/collections`, {});
    assert.equal(created.status, 201);
    const entity = created.body.entities[0];
    assert.equal(entity.fields.stock.status, 'confirmed');
    assert.equal(entity.fields.stock.value, null);
    assert.equal(entity.fields.price.status, 'forbidden');
    assert.ok(!('value' in entity.fields.price));
    assert.equal(entity.fields.gone.status, 'temporary');
    assert.equal(entity.fields.weird.status, 'temporary');
    assert.equal(entity.fields.weird.lastError.code, 'QUOTA');
    assert.equal(entity.fields.absent.status, 'missing');
    assert.equal(entity.fields.absent.detail, 'field_absent');
    assert.deepEqual(bodies[0].fields, ['absent', 'gone', 'price', 'stock', 'weird']);
    const price = created.body.outstanding.find(entry => entry.field === 'price');
    assert.equal(price.retriable, false);
    const reclaimed = await postJson(`${service.url}/collections/${created.body.id}/claims`, {});
    assert.equal(reclaimed.status, 200);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1].fields, ['absent', 'gone', 'weird']);
    assert.deepEqual(bodies[1].representations, [{ __typename: 'Product', key: { model: 'X' } }]);
  } finally {
    await service.close();
    await new Promise(resolve => stub.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('未知采集字段、越界路径与未知批次被拒绝', async () => {
  const { service, close } = await sandbox();
  try {
    const unknown = await postJson(`${service.url}/collections`, { fields: ['nope'] });
    assert.equal(unknown.status, 422);
    assert.match(unknown.body.error, /unknown_fields/);
    assert.deepEqual(await (await fetch(`${service.url}/collections`)).json(), []);
    const foreign = await postJson(`${service.url}/collections`, { path: 'https://example.invalid/foreign' });
    assert.equal(foreign.status, 422);
    const missing = await fetch(`${service.url}/collections/${randomUUID()}`);
    assert.equal(missing.status, 404);
    const claimMissing = await postJson(`${service.url}/collections/${randomUUID()}/claims`, {});
    assert.equal(claimMissing.status, 404);
    const missingOutstanding = await fetch(`${service.url}/collections/${randomUUID()}/outstanding`);
    assert.equal(missingOutstanding.status, 404);
  } finally { await close(); }
});
