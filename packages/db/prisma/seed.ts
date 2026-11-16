import { createDb } from "../src/index";
import { seedDemoOrders } from "./seed-orders";
import { seedRateLab } from "./seed-rate-lab";

const db = createDb();

// Each box's barcode is the one posted at its shelf (SPEC-packing A1): scanning it adds a package.
const boxes = [
  {
    name: "Small mailer",
    lengthIn: 6,
    widthIn: 4,
    heightIn: 2,
    maxWeightOz: 64,
    tareWeightOz: 1.5,
    barcode: "BOX-SMALL",
  },
  {
    name: "Medium box",
    lengthIn: 10,
    widthIn: 8,
    heightIn: 4,
    minWeightOz: 12,
    maxWeightOz: 320,
    tareWeightOz: 5,
    barcode: "BOX-MEDIUM",
    outerLengthIn: 10.25,
    outerWidthIn: 8.25,
    outerHeightIn: 4.25,
  },
  {
    name: "Large box",
    lengthIn: 14,
    widthIn: 12,
    heightIn: 8,
    minWeightOz: 32,
    maxWeightOz: 800,
    tareWeightOz: 9,
    barcode: "BOX-LARGE",
  },
];

async function main() {
  await db.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  for (const box of boxes) {
    await db.box.upsert({ where: { name: box.name }, create: box, update: {} });
  }
  console.log(`Seeded settings and ${boxes.length} boxes`);

  // Demo data is for the dev stack only (SPEC-workflow "Dev data"); with the fake shipping
  // providers it carries their rates too (SPEC-carriers "Dev data"), and Rate Lab's runs
  // (SPEC-rate-lab "Dev data").
  if (process.env.NODE_ENV !== "production") {
    const fakeShipping = process.env.SHIPPING_PROVIDERS === "fake";
    console.log(`Seeded ${await seedDemoOrders(db, { fakeShipping })} demo orders`);
    console.log(`Seeded Rate Lab data and ${await seedRateLab(db, { fakeShipping })} lab runs`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
