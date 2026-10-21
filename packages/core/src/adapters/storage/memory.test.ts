import { createMemoryStorage } from "./memory";
import { describeObjectStorage } from "./suite";

describeObjectStorage("MemoryStorage", async () => ({
  storage: createMemoryStorage({ bucketExists: false }),
}));
