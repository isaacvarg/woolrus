"use client";

/**
 * The nav inside the tablet drawer. A link click navigates client-side, which leaves the drawer's
 * checkbox checked and its overlay over the new page, so any link click unchecks it. Closing on
 * the click rather than on a pathname change also covers the link to the page already open.
 */
export function DrawerNav({ toggleId, children }: { toggleId: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegated from the links, which are keyboard reachable.
    <nav
      className="menu min-h-full w-64 bg-base-100 p-4"
      onClick={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("a")) return;
        const toggle = document.getElementById(toggleId);
        if (toggle instanceof HTMLInputElement) toggle.checked = false;
      }}
    >
      {children}
    </nav>
  );
}
