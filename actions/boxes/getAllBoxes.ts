'use server'

import prisma from "@/lib/prisma"

const _getAllBoxes = () =>
  prisma.box.findMany({
    include: { _count: { select: { packages: true } } },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  })

export type BoxWithUsage = Awaited<ReturnType<typeof _getAllBoxes>>[number]

export const getAllBoxes = async (): Promise<BoxWithUsage[]> => {
  return _getAllBoxes()
}
