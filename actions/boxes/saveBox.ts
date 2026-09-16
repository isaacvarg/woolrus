'use server'

import prisma from "@/lib/prisma"

export interface BoxInput {
  name: string
  length: number
  width: number
  height: number
  maxWeight: number | null
}

export type BoxErrorCode = 'nameRequired' | 'invalidDimensions' | 'invalidMaxWeight' | 'inUse'

export type BoxResult = { ok: true } | { ok: false, error: BoxErrorCode }

const isPositive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0

const validate = (input: BoxInput): BoxInput | BoxErrorCode => {
  const name = input.name?.trim()
  if (!name) return 'nameRequired'
  if (!isPositive(input.length) || !isPositive(input.width) || !isPositive(input.height)) {
    return 'invalidDimensions'
  }
  if (input.maxWeight != null && !isPositive(input.maxWeight)) return 'invalidMaxWeight'
  return {
    name,
    length: input.length,
    width: input.width,
    height: input.height,
    maxWeight: input.maxWeight ?? null,
  }
}

export const createBox = async (input: BoxInput): Promise<BoxResult> => {
  const data = validate(input)
  if (typeof data === 'string') return { ok: false, error: data }
  await prisma.box.create({ data })
  return { ok: true }
}

export const updateBox = async (id: string, input: BoxInput): Promise<BoxResult> => {
  const data = validate(input)
  if (typeof data === 'string') return { ok: false, error: data }
  await prisma.box.update({ where: { id }, data })
  return { ok: true }
}
