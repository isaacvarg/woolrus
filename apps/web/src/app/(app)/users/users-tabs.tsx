"use client";

import { useTranslations } from "next-intl";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { InvitationsManager } from "./invitations-manager";
import { UsersManager } from "./users-manager";

const tabClass = ({ isSelected }: { isSelected: boolean }) =>
  `tab cursor-pointer outline-none ${isSelected ? "tab-active" : ""}`;

export type UsersTab = "users" | "invitations";

/** The tab lives in `?tab=`, so a reload or a link keeps it. */
export function UsersTabs({
  currentUserId,
  initialTab,
}: {
  currentUserId: string;
  initialTab: UsersTab;
}) {
  const t = useTranslations("invitations");
  return (
    <Tabs
      className="space-y-4"
      defaultSelectedKey={initialTab}
      onSelectionChange={(key) => {
        const url = new URL(window.location.href);
        if (key === "users") url.searchParams.delete("tab");
        else url.searchParams.set("tab", String(key));
        window.history.replaceState(null, "", url);
      }}
    >
      <TabList className="tabs tabs-border" aria-label={t("usersTab")}>
        <Tab id="users" className={tabClass}>
          {t("usersTab")}
        </Tab>
        <Tab id="invitations" className={tabClass}>
          {t("tab")}
        </Tab>
      </TabList>
      <TabPanel id="users">
        <UsersManager currentUserId={currentUserId} />
      </TabPanel>
      <TabPanel id="invitations">
        <InvitationsManager />
      </TabPanel>
    </Tabs>
  );
}
