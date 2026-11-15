export function inspect(bytes) {
  const payload = JSON.parse(bytes.toString('utf8'));
  if (!payload.data || !Array.isArray(payload.data.products)) throw new Error('product_list_required');
  const products = payload.data.products.map((product, position) => {
    if (typeof product.__typename !== 'string' || !product.key || typeof product.key !== 'object')
      throw new Error(`entity_representation_${position}`);
    return { type: product.__typename, key: product.key, fields: product.fields ?? {}, position };
  });
  return { kind: 'product-representations', products, errors: payload.errors ?? [] };
}
export function representationKey(product) {
  const ordered = Object.entries(product.key).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([product.type, ordered]);
}
