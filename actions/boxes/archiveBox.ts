'use server'

import prisma from "@/lib/prisma"
import type { BoxResult } from "./saveBox"

export const setBoxActive = async (id: string, isActive: boolean) => {
  await prisma.box.update({
    where: { id },
    data: { isActive },
  })
}

// Boxes that have been used by a package can only be archived, since packages
// keep a reference to their box.
export const deleteBox = async (id: string): Promise<BoxResult> => {
  const packageCount = await prisma.package.count({ where: { boxId: id } })
  if (packageCount > 0) return { ok: false, error: 'inUse' }
  await prisma.box.delete({ where: { id } })
  return { ok: true }
}
