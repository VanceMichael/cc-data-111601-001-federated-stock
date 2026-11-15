import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, representationKey } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('复合键次序无关且类型隔离', () => {
  const first=inspect(primary).products[0];
  assert.equal(representationKey(first),representationKey({...first,key:{variant:'blue',model:'R1'}}));
  assert.notEqual(representationKey(first),representationKey({...first,type:'Accessory'}));
  assert.equal(inspect(primary).products.length,2);
});
test('空库存和字段级错误同时保留', async () => {
  const payload=JSON.parse(await resource('/warehouses'));
  assert.equal(payload.data.entities[0].fields.stock.south,null);
  assert.equal(payload.errors[0].code,'TEMPORARY');
});
test('不完整表示不能作为实体',()=>assert.throws(()=>inspect(Buffer.from('{"data":{"products":[{"key":{}}]}}'))));
