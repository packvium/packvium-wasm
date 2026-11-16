/**
 * A cart page that shows parcels and a shipping estimate without calling your server.
 *
 * Run it:
 *
 *     node examples/checkout.mjs
 *
 * In a storefront the customer changes a quantity and expects the shipping line to follow.
 * With the engine in the page there is no request to wait for: `estimate` below packs the
 * cart, checks the plan and prices each parcel, and your UI code renders what it returns.
 *
 * It answers with one of three shapes, so the page never has to guess:
 *
 * - `{ ok: true, parcels, shippingMinor, leftOut }`: what to show;
 * - `{ ok: false, field, message }`: the cart itself is wrong (a quantity of zero typed
 *   into the form), with a JSON Pointer to the bad value so you can mark the input;
 * - a thrown error for anything else, which is a bug and should reach your error reporter.
 *
 * The server recomputes the same numbers from the same request when the order is placed:
 * the tariff is pinned by version, and every amount is an exact integer.
 */

import { InvalidRequestError, commerce, init, pack, validate } from '@packvium/browser';

// Results carry exact integers: 16 000 length ticks to the millimetre, 8 000 000 weight
// ticks to the gram. A carrier bills whole millimetres and grams, rounded up.
const TICKS_PER_MM = 16000;
const TICKS_PER_GRAM = 8000000;

// Served to the page with the product data. A version's number is its position in the
// list, so `tariff_version: 1` means the same prices here and on the server.
const COMMERCE = {
  tariffs: [{
    carrier_id: 'postway',
    service_id: 'ground',
    versions: [{
      effective_at: 0,
      dimensional_weight_divisor: 6000,
      cost_per_dimensional_kg_minor: { domestic: 210 },
      minimum_charge_minor: 590,
      fuel_surcharge_permille: 90,
      accessorials: [],
    }],
  }],
  policy_rules: [],
  catalogs: [],
};

const PRODUCTS = {
  kettle: { mm: [240, 220, 260], g: 1300, keep_upright: true },
  mug: { mm: [120, 90, 100], g: 350 },
  cookbook: { mm: [280, 220, 30], g: 900 },
  'floor-lamp': { mm: [1500, 300, 300], g: 4200 },
};

const BOXES = [
  { id: 'small', mm: [300, 250, 150], tareG: 150, maxKg: 5, costMinor: 45 },
  { id: 'medium', mm: [400, 300, 300], tareG: 260, maxKg: 12, costMinor: 80 },
  { id: 'large', mm: [600, 400, 400], tareG: 480, maxKg: 20, costMinor: 140 },
];

const measures = ([length, width, height]) => ({
  length: String(length), width: String(width), height: String(height),
});

function toRequest(cart) {
  return {
    units: { length: 'mm' },
    configuration: {
      objective: 'lowest_cost',
      // Counted work decides where the search stops, so the page and the server agree.
      // The time limit is a fuse against a hang, not a search limit.
      effort_budget: { max_candidates_evaluated: 200000 },
      time_limit_ms: 60000,
    },
    items: Object.entries(cart).map(([sku, quantity]) => ({
      id: sku,
      quantity,
      weight: `${PRODUCTS[sku].g} g`,
      keep_upright: PRODUCTS[sku].keep_upright ?? false,
      dimensions: measures(PRODUCTS[sku].mm),
    })),
    containers: BOXES.map((box) => ({
      id: box.id,
      inner_dimensions: measures(box.mm),
      tare_weight: `${box.tareG} g`,
      max_payload: `${box.maxKg} kg`,
      cost_minor: box.costMinor,
    })),
  };
}

async function shippingFor(container) {
  let volume = 1;
  for (const edge of ['length', 'width', 'height']) {
    volume *= Math.ceil(container.outer_dimensions[edge].ticks / TICKS_PER_MM);
  }
  const answer = await commerce.quote(COMMERCE, {
    carrier_id: 'postway', service_id: 'ground', tariff_version: 1, zone: 'domestic',
    actual_weight_g: Math.ceil(container.gross_weight.ticks / TICKS_PER_GRAM),
    volume_mm3: volume,
  });
  if (answer.status !== 'ok') throw new Error(`no price: ${answer.error.code}`);
  return answer.quote.total_minor;
}

async function estimate(cart) {
  const request = toRequest(cart);
  let result;
  try {
    result = await pack(request);
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    return { ok: false, field: error.field, message: error.detail };
  }
  // The validator shares no code with the solver. An issue here is a defect to report,
  // not something to show a customer.
  const issues = await validate(request, result);
  if (issues.length > 0) throw new Error(`plan failed validation: ${issues[0].code}`);

  const parcels = [];
  let shippingMinor = 0;
  for (const container of result.containers) {
    const minor = await shippingFor(container);
    shippingMinor += minor;
    parcels.push({ box: container.container_type, items: container.placements.length, minor });
  }
  const leftOut = [...new Set(result.unpacked_items.map((entry) => entry.item_type))].sort();
  return { ok: true, parcels, shippingMinor, leftOut };
}

// `init()` fetches and instantiates the module once. Call it when the cart page loads, so
// the first keystroke does not pay for it.
await init();

// What a cart page does on every change. Here the "render" is a console line.
const carts = [
  { mug: 2 },
  { mug: 6, cookbook: 4, kettle: 4 },
  { mug: 1, 'floor-lamp': 1 },
  { mug: 0 },
];
for (const cart of carts) {
  const answer = await estimate(cart);
  console.log(`\ncart ${JSON.stringify(cart)}`);
  if (!answer.ok) {
    console.log(`  mark the input at ${answer.field}: ${answer.message}`);
    continue;
  }
  for (const parcel of answer.parcels) {
    console.log(`  ${parcel.box.padEnd(6)} ${parcel.items} item(s), ${parcel.minor} minor units`);
  }
  console.log(`  shipping: ${answer.shippingMinor} minor units`);
  for (const sku of answer.leftOut) {
    console.log(`  ${sku} ships separately: it fits none of the cartons`);
  }
}
