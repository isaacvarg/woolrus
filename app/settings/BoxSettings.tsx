'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { getAllBoxes, type BoxWithUsage } from '@/actions/boxes/getAllBoxes'
import { createBox, updateBox, type BoxErrorCode, type BoxInput } from '@/actions/boxes/saveBox'
import { deleteBox, setBoxActive } from '@/actions/boxes/archiveBox'
import { useDataActions } from '@/store/dataSlice'

interface BoxForm {
  name: string
  length: string
  width: string
  height: string
  maxWeight: string
}

const emptyForm: BoxForm = { name: '', length: '', width: '', height: '', maxWeight: '' }

const toForm = (box: BoxWithUsage): BoxForm => ({
  name: box.name,
  length: String(box.length),
  width: String(box.width),
  height: String(box.height),
  maxWeight: box.maxWeight != null ? String(box.maxWeight) : '',
})

const toInput = (form: BoxForm): BoxInput => ({
  name: form.name,
  length: Number(form.length),
  width: Number(form.width),
  height: Number(form.height),
  maxWeight: form.maxWeight.trim() === '' ? null : Number(form.maxWeight),
})

const BoxSettings = () => {
  const t = useTranslations('settings.boxes')
  const { refreshBoxes } = useDataActions()
  const [boxes, setBoxes] = useState<BoxWithUsage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<BoxForm>(emptyForm)
  const [error, setError] = useState<BoxErrorCode | null>(null)
  const [saving, setSaving] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const load = useCallback(async () => {
    const data = await getAllBoxes()
    setBoxes(data)
    setLoaded(true)
  }, [])

  useEffect(() => { load() }, [load])

  const afterChange = async () => {
    await Promise.all([load(), refreshBoxes()])
  }

  const openAdd = () => {
    setEditingId(null)
    setForm(emptyForm)
    setError(null)
    dialogRef.current?.showModal()
  }

  const openEdit = (box: BoxWithUsage) => {
    setEditingId(box.id)
    setForm(toForm(box))
    setError(null)
    dialogRef.current?.showModal()
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const input = toInput(form)
      const result = editingId ? await updateBox(editingId, input) : await createBox(input)
      if (!result.ok) {
        setError(result.error)
        return
      }
      dialogRef.current?.close()
      await afterChange()
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (box: BoxWithUsage) => {
    await setBoxActive(box.id, !box.isActive)
    await afterChange()
  }

  const handleDelete = async (box: BoxWithUsage) => {
    if (!confirm(t('deleteConfirm', { name: box.name }))) return
    const result = await deleteBox(box.id)
    if (!result.ok) alert(t(`errors.${result.error}`))
    await afterChange()
  }

  const setField = (field: keyof BoxForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [field]: e.target.value }))

  if (!loaded) return null

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-base-content/60">{t('description')}</p>
        <button className="btn btn-sm btn-primary" onClick={openAdd}>
          {t('addButton')}
        </button>
      </div>

      {boxes.length === 0 ? (
        <div className="text-center py-12 text-base-content/50">
          {t('noBoxes')}
        </div>
      ) : (
        <div className="overflow-x-auto bg-base-200 rounded-box">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('dimensions')}</th>
                <th>{t('maxWeight')}</th>
                <th>{t('packagesUsed')}</th>
                <th>{t('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {boxes.map(box => {
                const inUse = box._count.packages > 0
                return (
                  <tr key={box.id} className={box.isActive ? '' : 'opacity-50'}>
                    <td className="font-medium">{box.name}</td>
                    <td>{t('dimensionsValue', { length: box.length, width: box.width, height: box.height })}</td>
                    <td>{box.maxWeight != null ? t('weightValue', { weight: box.maxWeight }) : '—'}</td>
                    <td>{box._count.packages}</td>
                    <td>
                      <span className={`badge badge-sm ${box.isActive ? 'badge-success' : 'badge-ghost'}`}>
                        {box.isActive ? t('active') : t('archived')}
                      </span>
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <button className="btn btn-xs btn-ghost" onClick={() => openEdit(box)}>
                          {t('edit')}
                        </button>
                        <button className="btn btn-xs btn-ghost" onClick={() => handleToggleActive(box)}>
                          {box.isActive ? t('archive') : t('restore')}
                        </button>
                        <span className={inUse ? 'tooltip tooltip-left' : ''} data-tip={inUse ? t('errors.inUse') : undefined}>
                          <button
                            className="btn btn-xs btn-ghost text-error"
                            onClick={() => handleDelete(box)}
                            disabled={inUse}
                          >
                            {t('delete')}
                          </button>
                        </span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <dialog ref={dialogRef} className="modal">
        <div className="modal-box">
          <h3 className="font-semibold text-lg mb-4">
            {editingId ? t('editTitle') : t('addTitle')}
          </h3>
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('name')}</span>
              <input
                className="input input-bordered w-full"
                value={form.name}
                onChange={setField('name')}
                required
                autoFocus
              />
            </label>
            <div className="grid grid-cols-3 gap-3">
              {(['length', 'width', 'height'] as const).map(field => (
                <label key={field} className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{t(field)}</span>
                  <input
                    className="input input-bordered w-full"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={form[field]}
                    onChange={setField(field)}
                    required
                  />
                </label>
              ))}
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('maxWeight')}</span>
              <input
                className="input input-bordered w-full"
                type="number"
                step="0.01"
                min="0.01"
                value={form.maxWeight}
                onChange={setField('maxWeight')}
                placeholder={t('maxWeightHint')}
              />
            </label>

            {error && <p className="text-sm text-error">{t(`errors.${error}`)}</p>}

            <div className="modal-action">
              <button type="button" className="btn btn-ghost" onClick={() => dialogRef.current?.close()}>
                {t('cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving && <span className="loading loading-spinner loading-xs" />}
                {t('save')}
              </button>
            </div>
          </form>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button>{t('cancel')}</button>
        </form>
      </dialog>
    </div>
  )
}

export default BoxSettings
