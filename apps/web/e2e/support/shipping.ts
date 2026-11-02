import {
  createS3Storage,
  ensureBucketOnFirstUse,
  FakeStoreAdapter,
  s3ConfigFromEnv,
} from "@woolrus/core";
import { createDb, type LabelStatus } from "@woolrus/db";
import { createOrder } from "./orders";
import { demoService } from "./qa";

// Ready and Completed orders for the shipping journeys: labels the way QA's purchase leaves them
// (a row per package, the PDF in object storage), without buying anything anywhere.

const db = createDb();
const storage = ensureBucketOnFirstUse(createS3Storage(s3ConfigFromEnv()));

/** A one-page PDF, as small as a label gets. */
function labelPdf(text: string): string {
  const stream = `BT /F1 18 Tf 36 200 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 432] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

export type ShippingOrder = Awaited<ReturnType<typeof shippingOrder>>;

/**
 * An order in `status` (Ready or Completed) with one package per entry of `labels`, each holding one
 * unit and a label in that state. Cleaned up with `cleanup`.
 */
export async function shippingOrder({
  status = "READY",
  labels = ["ACTIVE"],
  printCount = 0,
  address2,
  country = "US",
  customerName = `E2E ${crypto.randomUUID()}`,
  shipDate = new Date(),
}: {
  status?: "READY" | "COMPLETED";
  labels?: LabelStatus[];
  printCount?: number;
  address2?: string;
  country?: string;
  customerName?: string;
  shipDate?: Date;
} = {}) {
  const { carrier } = await demoService();
  const order = await createOrder({
    customerName,
    status,
    quantity: labels.length,
    ownProduct: true,
  });
  await db.order.update({
    where: { id: order.id },
    data: {
      completedAt: status === "COMPLETED" ? new Date() : null,
      shipTo: {
        name: customerName,
        address1: "1 Main St",
        ...(address2 ? { address2 } : {}),
        city: country === "CA" ? "Toronto" : "Austin",
        state: country === "CA" ? "ON" : "TX",
        postalCode: country === "CA" ? "M5V 2T6" : "78701",
        country,
      },
    },
  });
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const labelIds: string[] = [];
  const keys: string[] = [];
  for (const [index, state] of labels.entries()) {
    const number = index + 1;
    const pkg = await db.package.create({
      data: { orderId: order.id, number, weightOz: 16, lengthIn: 8, widthIn: 6, heightIn: 4 },
    });
    await db.packageItem.create({
      data: { packageId: pkg.id, orderItemId: line.id, quantity: 1, qaVerifiedQuantity: 1 },
    });
    const id = crypto.randomUUID();
    const key = `e2e/labels/${id}.pdf`;
    await storage.put(
      key,
      new TextEncoder().encode(labelPdf(`E2E LABEL ${id}`)),
      "application/pdf",
    );
    keys.push(key);
    const label = await db.shippingLabel.create({
      data: {
        packageId: pkg.id,
        status: state,
        provider: "SHIPSTATION",
        idempotencyKey: `e2e-${id}`,
        providerLabelId: `se-e2e-${id}`,
        trackingNumber: `9400E2E${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        carrierCode: "demo_ground",
        serviceCode: "demo_ground",
        costCents: 450,
        currency: "USD",
        carrierId: carrier.id,
        storageKey: key,
        shipDate,
        printCount,
        purchasedAt: new Date(),
        ...(state === "VOID_REJECTED" ? { error: "errors.qa.voidRejected" } : {}),
      },
    });
    labelIds.push(label.id);
  }
  return {
    order,
    customerName,
    /** A distinct word of the customer name, to find the order in a queue by search. */
    token: customerName.split(" ").at(-1) as string,
    labelIds,
    async cleanup() {
      await db.shippingLabel.deleteMany({ where: { id: { in: labelIds } } });
      await db.labelPrint.deleteMany({ where: { labelIds: { hasSome: labelIds } } });
      await storage.delete(keys).catch(() => {});
      await db.$executeRaw`DELETE FROM pgboss.job WHERE name = 'woo.push' AND data->>'orderId' = ${order.id}`;
    },
  };
}

/** A fake store with this order in it, so a push has something to complete; the Woolrus order points at it. */
export async function fakeStoreFor(orderId: string) {
  const store = new FakeStoreAdapter();
  // Both projects run at once and the fake store counts from the same number: skip to an unused id.
  for (let skip = Math.floor(Math.random() * 5000); skip > 0; skip--) store.addOrder();
  let woo = store.addOrder();
  while (await db.order.findUnique({ where: { wooOrderId: woo.id } })) woo = store.addOrder();
  await db.order.update({ where: { id: orderId }, data: { wooOrderId: woo.id } });
  return { store, wooId: woo.id };
}
