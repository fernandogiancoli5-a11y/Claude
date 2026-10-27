// A tiny shopping cart. Prices are integer cents to avoid floating-point errors.

export function createCart() {
  return { items: [] };
}

export function addItem(cart, { sku, priceCents, quantity = 1 }) {
  if (!sku) throw new Error("sku is required");
  if (!Number.isInteger(priceCents) || priceCents < 0)
    throw new Error("priceCents must be a non-negative integer");
  if (!Number.isInteger(quantity) || quantity < 1)
    throw new Error("quantity must be a positive integer");
  const existing = cart.items.find((item) => item.sku === sku);
  if (existing) existing.quantity += quantity;
  else cart.items.push({ sku, priceCents, quantity });
  return cart;
}

export function removeItem(cart, sku) {
  cart.items = cart.items.filter((item) => item.sku !== sku);
  return cart;
}

export function subtotalCents(cart) {
  return cart.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
}
