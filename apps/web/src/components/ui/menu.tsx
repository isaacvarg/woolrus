"use client";

// A dropdown action menu: React Aria handles the trigger, arrow keys, typeahead and focus return;
// daisyUI's .menu does the styling. Items act through `onAction`; open dialogs from there as
// controlled `<Dialog isOpen>` rather than nesting DialogTriggers inside the popover.
import type { ReactNode } from "react";
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps,
  MenuTrigger,
  Popover,
} from "react-aria-components";
import { Button } from "./fields";

export function Menu({
  label,
  trigger,
  children,
}: {
  /** The trigger's accessible name, e.g. "Actions for Ana". */
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <MenuTrigger>
      <Button className="btn-ghost btn-sm" aria-label={label}>
        {trigger}
      </Button>
      <Popover placement="bottom end" className="rounded-box bg-base-100 shadow-lg">
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
        `cursor-pointer rounded-field px-3 py-2 outline-none ${isFocused ? "bg-base-200" : ""} ${
          danger ? "text-error" : ""
        }`
      }
    >
      {children}
    </AriaMenuItem>
  );
}
