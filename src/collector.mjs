import { representationKey } from './reader.mjs';

// 已确认与无权查看的字段不再补领；显式 null 是已确认的值，与未收到不同。
const LOCKED = new Set(['confirmed', 'forbidden']);

export function parseCatalog(bytes) {
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('catalog_invalid'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('catalog_invalid');
  for (const name of ['entry', 'ownership'])
    if (payload[name] !== undefined && typeof payload[name] !== 'string') throw new Error('catalog_invalid');
  const services = payload.services ?? {};
  if (!services || typeof services !== 'object' || Array.isArray(services)) throw new Error('catalog_invalid');
  for (const path of Object.values(services)) if (typeof path !== 'string') throw new Error('catalog_invalid');
  return { entry: payload.entry ?? '/primary', ownership: payload.ownership ?? '/schema', services };
}

export function parseSchema(bytes) {
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('schema_invalid'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('schema_invalid');
  for (const fields of Object.values(payload)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('schema_invalid');
    for (const service of Object.values(fields))
      if (typeof service !== 'string' || service.length === 0) throw new Error('schema_invalid');
  }
  return payload;
}

export function createCollection({ id, source, entry, ownership, services, products, fields, at }) {
  if (fields !== undefined && (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')))
    throw new Error('fields_invalid');
  const types = [...new Set(products.map(product => product.type))];
  if (fields) {
    const known = new Set(types.flatMap(type => Object.keys(ownership[type] ?? {})));
    const unknown = fields.filter(field => !known.has(field));
    if (unknown.length) throw new Error(`unknown_fields:${unknown.join(',')}`);
  }
  const plan = {};
  for (const type of types) {
    const owned = Object.keys(ownership[type] ?? {});
    plan[type] = (fields ? owned.filter(field => fields.includes(field)) : owned).sort();
  }
  const entities = {};
  for (const product of products) {
    const entityId = representationKey(product);
    entities[entityId] = { id: entityId, type: product.type, key: product.key, fields: {} };
  }
  return { id, source, entry, createdAt: at, ownership, services, plan, entities, requests: [] };
}

export function recordRequest(collection, entry) {
  const id = (collection.requests.at(-1)?.id ?? 0) + 1;
  collection.requests.push({ id, at: new Date().toISOString(), ...entry });
  return id;
}

export function applyPrimary(collection, products, requestId, at) {
  for (const product of products) {
    const entity = collection.entities[representationKey(product)];
    if (!entity) continue;
    for (const [field, value] of Object.entries(product.fields ?? {})) {
      const current = entity.fields[field];
      if (current && LOCKED.has(current.status)) continue;
      entity.fields[field] = { status: 'confirmed', value,
        origin: { request: requestId, service: collection.ownership[entity.type]?.[field] ?? 'products',
          path: collection.entry, at } };
    }
  }
}

// 只为未确认且可再领的字段生成领取计划，按归属服务分组；已确认与无权字段不出现。
export function planClaims(collection) {
  const groups = new Map();
  for (const entity of Object.values(collection.entities)) {
    for (const field of collection.plan[entity.type] ?? []) {
      const status = entity.fields[field]?.status;
      if (status && LOCKED.has(status)) continue;
      const service = collection.ownership[entity.type]?.[field];
      const path = service ? collection.services[service] : undefined;
      if (!path) continue;
      if (!groups.has(service)) groups.set(service, { service, path, representations: new Map(), fields: new Set() });
      const group = groups.get(service);
      group.representations.set(entity.id, { __typename: entity.type, key: entity.key });
      group.fields.add(field);
    }
  }
  return [...groups.values()].map(group => ({
    service: group.service, path: group.path,
    representations: [...group.representations.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1)).map(([, representation]) => representation),
    fields: [...group.fields].sort(),
  })).sort((left, right) => left.service.localeCompare(right.service));
}

function lockedFields(collection, claim) {
  const locked = new Set();
  for (const representation of claim.representations) {
    const entityId = representationKey({ type: representation.__typename, key: representation.key });
    for (const field of claim.fields) {
      const status = collection.entities[entityId]?.fields[field]?.status;
      if (status && LOCKED.has(status)) locked.add(`${entityId} ${field}`);
    }
  }
  return locked;
}

// 实体按类型和完整 key 关联，不按返回顺序；错误 path 指向响应 entities 下标。
// 无法归属到具体实体的同名字段错误不确认该次响应里的任何同名字段，避免把失败当成空值。
export function applyClaim(collection, claim, payload, requestId, at) {
  const entities = payload?.data?.entities;
  if (!Array.isArray(entities)) return markClaimFailed(collection, claim, requestId, at, 'invalid_entity_response');
  const locked = lockedFields(collection, claim);
  const found = new Map();
  for (const item of entities) {
    if (item && typeof item.__typename === 'string' && item.key && typeof item.key === 'object')
      found.set(representationKey({ type: item.__typename, key: item.key }), item);
  }
  for (const representation of claim.representations) {
    const entityId = representationKey({ type: representation.__typename, key: representation.key });
    const entity = collection.entities[entityId];
    if (!entity) continue;
    const item = found.get(entityId);
    const itemFields = item && item.fields && typeof item.fields === 'object' ? item.fields : {};
    for (const field of claim.fields) {
      if (locked.has(`${entityId} ${field}`)) continue;
      if (!item) entity.fields[field] = { status: 'missing', detail: 'no_matching_entity', requested: requestId };
      else if (Object.hasOwn(itemFields, field)) entity.fields[field] = { status: 'confirmed', value: itemFields[field],
        origin: { request: requestId, service: claim.service, path: claim.path, at }, requested: requestId };
      else entity.fields[field] = { status: 'missing', detail: 'field_absent', requested: requestId };
    }
  }
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const dangling = [];
  for (const error of errors) {
    const path = Array.isArray(error?.path) ? error.path : [];
    const [head, index, segment, field] = path;
    if (head !== 'entities' || !Number.isInteger(index) || segment !== 'fields' || typeof field !== 'string') continue;
    if (!claim.fields.includes(field)) continue;
    const item = entities[index];
    let entityId = null;
    if (item && typeof item.__typename === 'string' && item.key && typeof item.key === 'object')
      entityId = representationKey({ type: item.__typename, key: item.key });
    else if (claim.representations[index])
      entityId = representationKey({ type: claim.representations[index].__typename, key: claim.representations[index].key });
    if (!entityId) { dangling.push(error); continue; }
    const entity = collection.entities[entityId];
    if (!entity || locked.has(`${entityId} ${field}`)) continue;
    const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
    const lastError = { code, request: requestId, at };
    entity.fields[field] = code === 'FORBIDDEN'
      ? { status: 'forbidden', lastError, requested: requestId }
      : { status: 'temporary', lastError, requested: requestId };
  }
  for (const error of dangling) {
    const field = error.path[3];
    const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
    for (const representation of claim.representations) {
      const entityId = representationKey({ type: representation.__typename, key: representation.key });
      const entity = collection.entities[entityId];
      if (!entity || locked.has(`${entityId} ${field}`)) continue;
      entity.fields[field] = { status: 'temporary', lastError: { code, request: requestId, at }, requested: requestId };
    }
  }
}

export function markClaimFailed(collection, claim, requestId, at, code) {
  for (const representation of claim.representations) {
    const entityId = representationKey({ type: representation.__typename, key: representation.key });
    const entity = collection.entities[entityId];
    if (!entity) continue;
    for (const field of claim.fields) {
      const status = entity.fields[field]?.status;
      if (status && LOCKED.has(status)) continue;
      entity.fields[field] = { status: 'temporary', lastError: { code, request: requestId, at }, requested: requestId };
    }
  }
}

export function outstanding(collection) {
  const result = [];
  for (const entity of Object.values(collection.entities)) {
    for (const field of collection.plan[entity.type] ?? []) {
      const state = entity.fields[field];
      if (state?.status === 'confirmed') continue;
      const service = collection.ownership[entity.type]?.[field];
      const status = state?.status ?? 'pending';
      const entry = { entity: entity.id, type: entity.type, key: entity.key, field, service: service ?? null,
        status, retriable: status !== 'forbidden' && Boolean(service && collection.services[service]) };
      if (state?.detail) entry.detail = state.detail;
      if (state?.lastError) entry.lastError = state.lastError;
      if (state?.requested) entry.requested = state.requested;
      result.push(entry);
    }
  }
  return result.sort((left, right) => left.entity === right.entity
    ? left.field.localeCompare(right.field) : left.entity < right.entity ? -1 : 1);
}

export function isComplete(collection, entity) {
  return (collection.plan[entity.type] ?? []).every(field => entity.fields[field]?.status === 'confirmed');
}

export function view(collection) {
  const entities = Object.values(collection.entities)
    .map(entity => ({ ...entity, complete: isComplete(collection, entity) }));
  return { id: collection.id, source: collection.source, entry: collection.entry, createdAt: collection.createdAt,
    ownership: collection.ownership, services: collection.services, plan: collection.plan,
    complete: entities.every(entity => entity.complete), entities,
    outstanding: outstanding(collection), requests: collection.requests };
}

export function summarize(collection) {
  const entities = Object.values(collection.entities);
  return { id: collection.id, createdAt: collection.createdAt, source: collection.source, entry: collection.entry,
    entities: entities.length, complete: entities.every(entity => isComplete(collection, entity)),
    outstanding: outstanding(collection).length, requests: collection.requests.length };
}
