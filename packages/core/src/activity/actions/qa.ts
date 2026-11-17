import { defineActions } from "./types";

// QA: scans, verification, box confirmation, check acknowledgements, approvals and lot
// replacement. Wording comes with #201.

export const qaActions = defineActions({
  "packageItem.scan": { category: "qa", groups: true },
  "packageItem.verify": { category: "qa", groups: true },
  "packageItem.unverify": { category: "qa", groups: true },
  "package.confirmBox": { category: "qa", groups: false },
  "packCheckTrip.acknowledge": { category: "qa", groups: false },
  "PackageCheckTrip.archive": { category: "qa", groups: false },
  "PackageCheckTrip.unarchive": { category: "qa", groups: false },
  "approval.grant": { category: "qa", groups: false },
  "lot.qaReplace": { category: "qa", groups: false },
  "lot.qaRemove": { category: "qa", groups: false },
});
