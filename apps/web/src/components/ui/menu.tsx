"use client";

// A dropdown action menu: React Aria handles the trigger, arrow keys, typeahead and focus return;
// daisyUI's .menu does the styling. Items act through `onAction`; open dialogs from there as
// controlled `<Dialog isOpen>` rather than nesting DialogTriggers inside the popover.
import type { ReactNode } from "react";
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  Header,
  type MenuItemProps,
  type MenuSectionProps,
  MenuTrigger,
  Popover,
} from "react-aria-components";
import { Button } from "./fields";

export function Menu({
  label,
  trigger,
  children,
  placement = "bottom end",
  triggerClassName = "btn-ghost btn-sm",
}: {
  /** The trigger's accessible name, e.g. "Actions for Ana". */
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  placement?: "bottom end" | "top start";
  triggerClassName?: string;
}) {
  return (
    <MenuTrigger>
      <Button className={triggerClassName} aria-label={label}>
        {trigger}
      </Button>
      <Popover placement={placement} className="rounded-box bg-base-100 shadow-lg">
        <AriaMenu className="menu w-48 outline-none">{children}</AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}

export function MenuItem({
  children,
  danger = false,
  ...props
}: Omit<MenuItemProps, "children" | "className"> & { children: ReactNode; danger?: boolean }) {
  return (
    <AriaMenuItem
      {...props}
      className={({ isFocused }) =>
        `flex cursor-pointer gap-2 rounded-field px-3 py-2 outline-none ${
          isFocused ? "bg-base-200" : ""
        } ${danger ? "text-error" : ""}`
      }
    >
      {({ isSelected, selectionMode }) => (
        <>
          {selectionMode !== "none" && (
            <span aria-hidden="true" className="w-4">
              {isSelected ? "✓" : ""}
            </span>
          )}
          {children}
        </>
      )}
    </AriaMenuItem>
  );
}

/**
 * A titled group of items. With `selectionMode="single"` its items are radio items: React Aria
 * announces the checked one, and `onSelectionChange` reports the pick.
 */
export function MenuSection<T extends object>({
  title,
  children,
  ...props
}: Omit<MenuSectionProps<T>, "children" | "className"> & { title: string; children: ReactNode }) {
  return (
    <AriaMenuSection {...props} className="py-1">
      <Header className="menu-title">{title}</Header>
      {children}
    </AriaMenuSection>
  );
}
