import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const post = async (base, path, body) => {
  const response = await fetch(`${base}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const intake = await post(service.url, '/intakes', { path: '/primary' });
  if (intake.status !== 201) throw new Error('intake_failed');
  console.log('单件接收', intake.body.id);
  const created = await post(service.url, '/collections', { fields: ['name', 'stock'] });
  if (created.status !== 201) throw new Error('collection_failed');
  let collection = created.body;
  console.log('首次领取完成度', collection.complete, '未收到', collection.outstanding);
  const full = await post(service.url, '/collections', {});
  if (full.status !== 201) throw new Error('collection_failed');
  console.log('全字段计划未收到', full.body.outstanding);
  await post(provider.url, '/_phase', { phase: 1 });
  const reclaimed = await post(service.url, `/collections/${collection.id}/claims`, {});
  if (reclaimed.status !== 200) throw new Error('claim_failed');
  collection = reclaimed.body;
  console.log('补领后完成度', collection.complete, '未收到', collection.outstanding);
  const red = collection.entities.find(entity => entity.key.variant === 'red');
  const origin = collection.requests.find(entry => entry.id === red.fields.stock.origin.request);
  console.log('红色型号库存', red.fields.stock.value, '来自请求', origin);
  console.log('领取请求序列', collection.requests.map(({ id, service: name, path, method, fields, representations }) =>
    ({ id, service: name, path, method, fields, representations })));
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
