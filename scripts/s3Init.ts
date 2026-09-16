import "dotenv/config";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { s3 } from "@/lib/s3";

async function main() {
  const bucket = process.env.S3_NOTES_BUCKET;
  if (!bucket) throw new Error('S3_NOTES_BUCKET is not set');

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`Bucket "${bucket}" already exists`);
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw err;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Created bucket "${bucket}"`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
