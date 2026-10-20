"use client";

import { useMutation } from "@tanstack/react-query";
import type { Preferences, UpdatePreferencesInput } from "@woolrus/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button } from "@/components/ui/fields";
import { Menu, MenuItem, MenuSection } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { preferenceCookie } from "@/lib/preferences";

const locales = { en: "English", es: "Español" } as const;
const themes = ["SYSTEM", "LIGHT", "DARK", "HIGH_CONTRAST"] as const;

/**
 * Who is signed in, their preferences (FR-SET-03), sidebar collapse and Log out. Preferences save
 * on the user; a refresh then re-renders the layout in the new language and theme. On a station
 * it names the station, and Lock replaces Log out (SPEC-identity "Manual lock").
 */
export function NavFooter({
  name,
  email,
  stationName,
  preferences,
}: {
  name: string;
  email: string;
  stationName: string | null;
  preferences: Preferences;
}) {
  const t = useTranslations("navFooter");
  const router = useRouter();
  const errorMessage = useErrorMessage();

  // A sign-in on a new device applies the stored preferences server-side; copy them into the
  // cookies too, so the sign-in page keeps them after Log out.
  useEffect(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is async and not in every browser yet.
    document.cookie = preferenceCookie("locale", preferences.locale);
    // biome-ignore lint/suspicious/noDocumentCookie: as above.
    document.cookie = preferenceCookie("theme", preferences.theme);
  }, [preferences.locale, preferences.theme]);

  const update = useMutation(
    orpc.me.updatePreferences.mutationOptions({
      onSuccess: () => router.refresh(),
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );
  const save = (patch: UpdatePreferencesInput) => update.mutate(patch);

  const signOut = async () => {
    await authClient.signOut();
    // A full load drops every cached query of the signed-out user.
    window.location.assign("/sign-in");
  };

  const lock = useMutation(
    orpc.station.lock.mutationOptions({
      // A full load drops every cached query of the user who just locked.
      onSuccess: () => window.location.assign("/station"),
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );

  return (
    <div className="mt-auto flex flex-col gap-2 border-t border-base-300 pt-4">
      <div className="px-2">
        <p className="truncate font-semibold">{name}</p>
        <p className="truncate text-sm opacity-70">
          {stationName ? t("station", { name: stationName }) : email}
        </p>
      </div>
      <Menu
        label={t("preferences")}
        trigger={t("preferences")}
        placement="top start"
        triggerClassName="btn-ghost btn-sm justify-start"
      >
        <MenuSection
          title={t("language")}
          selectionMode="single"
          selectedKeys={[preferences.locale]}
          onSelectionChange={(keys) => {
            const [locale] = [...keys];
            if (locale === "en" || locale === "es") save({ locale });
          }}
        >
          {Object.entries(locales).map(([id, label]) => (
            <MenuItem key={id} id={id} lang={id}>
              {label}
            </MenuItem>
          ))}
        </MenuSection>
        <MenuSection
          title={t("theme")}
          selectionMode="single"
          selectedKeys={[preferences.theme]}
          onSelectionChange={(keys) => {
            const theme = themes.find((id) => keys !== "all" && keys.has(id));
            if (theme) save({ theme });
          }}
        >
          {themes.map((id) => (
            <MenuItem key={id} id={id}>
              {t(`themes.${id}`)}
            </MenuItem>
          ))}
        </MenuSection>
      </Menu>
      {/* Collapsing only means something where the sidebar is pinned open (desktop). */}
      <Button
        className="btn-ghost btn-sm hidden justify-start lg:inline-flex"
        onPress={() => save({ sidebarCollapsed: !preferences.sidebarCollapsed })}
      >
        {preferences.sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
      </Button>
      {stationName ? (
        <>
          {/* The lock screen, while this user's turn goes on until someone else unlocks. */}
          <Link href="/station" className="btn btn-ghost btn-sm justify-start">
            {t("switchUser")}
          </Link>
          <Button
            className="btn-ghost btn-sm justify-start"
            isPending={lock.isPending}
            onPress={() => lock.mutate({})}
          >
            {t("lock")}
          </Button>
        </>
      ) : (
        <Button className="btn-ghost btn-sm justify-start" onPress={signOut}>
          {t("logOut")}
        </Button>
      )}
    </div>
  );
}
