# tiny-cart

A deliberately tiny, dependency-free shopping cart used as the **disposable sample
project** for Pairloom demos and end-to-end tests. It contains no private or
third-party code and can be modified freely.

```bash
npm test   # node --test, no install step
```

## Demo task

> Add `applyDiscount(cart, code)` to `src/cart.js`. Code `SAVE10` takes 10% off the
> subtotal (round down to whole cents); unknown codes throw an Error. Add tests in
> `test/discount.test.js` and make sure `npm test` passes.
