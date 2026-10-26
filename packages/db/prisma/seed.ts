import { createDb } from "../src/index";
import { seedDemoOrders } from "./seed-orders";

const db = createDb();

const boxes = [
  {
    name: "Small mailer",
    lengthIn: 6,
    widthIn: 4,
    heightIn: 2,
    maxWeightOz: 64,
    tareWeightOz: 1.5,
  },
  {
    name: "Medium box",
    lengthIn: 10,
    widthIn: 8,
    heightIn: 4,
    maxWeightOz: 320,
    tareWeightOz: 5,
    outerLengthIn: 10.25,
    outerWidthIn: 8.25,
    outerHeightIn: 4.25,
  },
  { name: "Large box", lengthIn: 14, widthIn: 12, heightIn: 8, maxWeightOz: 800, tareWeightOz: 9 },
];

async function main() {
  await db.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  for (const box of boxes) {
    await db.box.upsert({ where: { name: box.name }, create: box, update: {} });
  }
  console.log(`Seeded settings and ${boxes.length} boxes`);

  // Demo data is for the dev stack only (SPEC-workflow "Dev data").
  if (process.env.NODE_ENV !== "production") {
    console.log(`Seeded ${await seedDemoOrders(db)} demo orders`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
