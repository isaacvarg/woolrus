"use client";

import type { UnlockTile } from "@woolrus/contracts";
import { Button } from "@/components/ui/fields";

/**
 * Large name tiles to find yourself by (initials + name, nothing to sign in with), shared by the
 * station lock screen and the approval dialog's approvers (SPEC-identity "UI").
 */
export function NameTiles({
  tiles,
  onChoose,
  className = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
}: {
  tiles: readonly UnlockTile[];
  onChoose: (tile: UnlockTile) => void;
  className?: string;
}) {
  return (
    <ul className={`grid gap-4 ${className}`}>
      {tiles.map((tile) => (
        <li key={tile.id}>
          <Button
            className="btn-outline flex h-28 w-full flex-col gap-1"
            onPress={() => onChoose(tile)}
          >
            <span aria-hidden className="text-3xl font-bold">
              {tile.initials}
            </span>
            <span className="text-lg">{tile.name}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
