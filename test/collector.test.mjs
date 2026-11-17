import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollection, applyPrimary, planClaims, applyClaim, markClaimFailed, recordRequest,
  outstanding, view, parseCatalog, parseSchema } from '../src/collector.mjs';
import { representationKey } from '../src/reader.mjs';

const ownership = { Product: { name: 'products', stock: 'warehouses', accessories: 'parts' },
  Accessory: { stock: 'parts' } };
const services = { warehouses: '/warehouses', parts: '/parts' };
const products = [
  { type: 'Product', key: { model: 'R1', variant: 'blue' }, fields: { name: '训练器' } },
  { type: 'Product', key: { model: 'R1', variant: 'red' }, fields: { name: '训练器' } },
];
const blueId = representationKey({ type: 'Product', key: { model: 'R1', variant: 'blue' } });
const redId = representationKey({ type: 'Product', key: { model: 'R1', variant: 'red' } });

function setup(fields = ['name', 'stock', 'accessories']) {
  const collection = createCollection({ id: 'c1', source: 'http://source', entry: '/primary',
    ownership, services, products, fields, at: '2026-11-17T00:00:00.000Z' });
  const requestId = recordRequest(collection, { service: 'products', path: '/primary', method: 'GET', outcome: 'ok' });
  applyPrimary(collection, products, requestId, '2026-11-17T00:00:01.000Z');
  return collection;
}

test('领取计划按归属服务分组且只含未确认字段', () => {
  const collection = setup(['name', 'stock']);
  const claims = planClaims(collection);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].service, 'warehouses');
  assert.equal(claims[0].path, '/warehouses');
  assert.deepEqual(claims[0].fields, ['stock']);
  assert.deepEqual(claims[0].representations.map(item => item.key.variant), ['blue', 'red']);
  assert.equal(collection.entities[blueId].fields.name.status, 'confirmed');
  assert.equal(collection.entities[blueId].fields.name.origin.service, 'products');
});

test('实体按键关联而非返回顺序，显式空值是已确认', () => {
  const collection = setup(['name', 'stock']);
  const [claim] = planClaims(collection);
  applyClaim(collection, claim, { data: { entities: [
    { __typename: 'Product', key: { model: 'R1', variant: 'red' }, fields: { stock: null } },
    { __typename: 'Product', key: { variant: 'blue', model: 'R1' }, fields: { stock: { north: 4, south: null } } },
  ] }, errors: [{ path: ['entities', 0, 'fields', 'stock'], code: 'TEMPORARY' }] }, 2, 't2');
  const blue = collection.entities[blueId].fields.stock;
  const red = collection.entities[redId].fields.stock;
  assert.equal(blue.status, 'confirmed');
  assert.deepEqual(blue.value, { north: 4, south: null });
  assert.equal(blue.origin.request, 2);
  assert.equal(red.status, 'temporary');
  assert.equal(red.lastError.code, 'TEMPORARY');
  const [next] = planClaims(collection);
  assert.deepEqual(next.representations.map(item => item.key.variant), ['red']);
});

test('未匹配实体不是空值，未请求字段的无权错误不污染所领字段', () => {
  const collection = setup();
  const parts = planClaims(collection).find(claim => claim.service === 'parts');
  assert.deepEqual(parts.fields, ['accessories']);
  applyClaim(collection, parts, { data: { entities: [null, null] },
    errors: [{ path: ['entities', 0, 'fields', 'price'], code: 'FORBIDDEN' }] }, 2, 't2');
  const accessories = collection.entities[blueId].fields.accessories;
  assert.equal(accessories.status, 'missing');
  assert.equal(accessories.detail, 'no_matching_entity');
  assert.ok(!('value' in accessories));
});

test('无权查看是终结状态，不伪装空值也不再补领', () => {
  const collection = setup(['accessories']);
  const [claim] = planClaims(collection);
  applyClaim(collection, claim, { data: { entities: [null, null] },
    errors: [{ path: ['entities', 0, 'fields', 'accessories'], code: 'FORBIDDEN' }] }, 2, 't2');
  const blue = collection.entities[blueId].fields.accessories;
  assert.equal(blue.status, 'forbidden');
  assert.ok(!('value' in blue));
  const [next] = planClaims(collection);
  assert.deepEqual(next.representations.map(item => item.key.variant), ['red']);
  const entry = outstanding(collection).find(item => item.entity === blueId);
  assert.equal(entry.status, 'forbidden');
  assert.equal(entry.retriable, false);
});

test('未知错误码按临时失败保留原码并可再领', () => {
  const collection = setup(['stock']);
  const [claim] = planClaims(collection);
  applyClaim(collection, claim, { data: { entities: [null, null] },
    errors: [{ path: ['entities', 0, 'fields', 'stock'], code: 'QUOTA' }] }, 2, 't2');
  const stock = collection.entities[blueId].fields.stock;
  assert.equal(stock.status, 'temporary');
  assert.equal(stock.lastError.code, 'QUOTA');
  assert.equal(planClaims(collection)[0].representations.length, 2);
});

test('无法归属到具体实体的字段错误不确认任何同名字段', () => {
  const collection = setup(['stock']);
  const [claim] = planClaims(collection);
  const subset = { ...claim, representations: claim.representations.filter(item => item.key.variant === 'red') };
  applyClaim(collection, subset, { data: { entities: [
    { __typename: 'Product', key: { model: 'R1', variant: 'red' }, fields: { stock: null } },
  ] }, errors: [{ path: ['entities', 1, 'fields', 'stock'], code: 'TEMPORARY' }] }, 2, 't2');
  const stock = collection.entities[redId].fields.stock;
  assert.equal(stock.status, 'temporary');
  assert.equal(stock.lastError.code, 'TEMPORARY');
  assert.ok(!('value' in stock));
});

test('请求失败记为临时失败且不覆盖已确认字段', () => {
  const collection = setup(['name', 'stock']);
  const [claim] = planClaims(collection);
  applyClaim(collection, claim, { data: { entities: [
    { __typename: 'Product', key: { model: 'R1', variant: 'blue' }, fields: { stock: { north: 4 } } }, null] } },
    2, 't2');
  markClaimFailed(collection, claim, 3, 't3', 'source_status_503');
  assert.equal(collection.entities[blueId].fields.stock.status, 'confirmed');
  assert.equal(collection.entities[redId].fields.stock.status, 'temporary');
  assert.equal(collection.entities[redId].fields.stock.lastError.code, 'source_status_503');
});

test('完整度与未收到清单随确认收敛', () => {
  const collection = setup(['name', 'stock']);
  assert.equal(view(collection).complete, false);
  assert.equal(outstanding(collection).length, 2);
  const [claim] = planClaims(collection);
  applyClaim(collection, claim, { data: { entities: [
    { __typename: 'Product', key: { model: 'R1', variant: 'blue' }, fields: { stock: { north: 4 } } },
    { __typename: 'Product', key: { model: 'R1', variant: 'red' }, fields: { stock: { north: 0 } } },
  ] } }, 2, 't2');
  assert.deepEqual(outstanding(collection), []);
  assert.equal(view(collection).complete, true);
  assert.equal(planClaims(collection).length, 0);
});

test('畸形目录与归属被拒绝，未知采集字段被拒绝', () => {
  assert.throws(() => parseCatalog(Buffer.from('not json')), /catalog_invalid/);
  assert.throws(() => parseCatalog(Buffer.from('{"services":{"x":1}}')), /catalog_invalid/);
  assert.throws(() => parseSchema(Buffer.from('{"Product":{"stock":""}}')), /schema_invalid/);
  assert.throws(() => createCollection({ id: 'c', source: 's', entry: '/primary', ownership, services,
    products, fields: ['nope'], at: 't' }), /unknown_fields:nope/);
  assert.throws(() => createCollection({ id: 'c', source: 's', entry: '/primary', ownership, services,
    products, fields: 'stock', at: 't' }), /fields_invalid/);
});
