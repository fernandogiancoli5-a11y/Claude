import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, createCart, removeItem, subtotalCents } from "../src/cart.js";

test("adds items and computes the subtotal", () => {
  const cart = createCart();
  addItem(cart, { sku: "apple", priceCents: 120, quantity: 3 });
  addItem(cart, { sku: "pear", priceCents: 250 });
  assert.equal(subtotalCents(cart), 610);
});

test("merges quantities for the same sku", () => {
  const cart = createCart();
  addItem(cart, { sku: "apple", priceCents: 120 });
  addItem(cart, { sku: "apple", priceCents: 120, quantity: 2 });
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].quantity, 3);
});

test("removes items", () => {
  const cart = createCart();
  addItem(cart, { sku: "apple", priceCents: 120 });
  removeItem(cart, "apple");
  assert.equal(subtotalCents(cart), 0);
});

test("rejects invalid prices", () => {
  assert.throws(() => addItem(createCart(), { sku: "x", priceCents: 1.5 }));
});
