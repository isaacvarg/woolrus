import { createDb } from "../src/index";

const db = createDb();

const boxes = [
  { name: "Small mailer", lengthIn: 6, widthIn: 4, heightIn: 2, maxWeightOz: 64 },
  { name: "Medium box", lengthIn: 10, widthIn: 8, heightIn: 4, maxWeightOz: 320 },
  { name: "Large box", lengthIn: 14, widthIn: 12, heightIn: 8, maxWeightOz: 800 },
];

async function main() {
  await db.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  for (const box of boxes) {
    await db.box.upsert({ where: { name: box.name }, create: box, update: {} });
  }
  console.log(`Seeded settings and ${boxes.length} boxes`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
