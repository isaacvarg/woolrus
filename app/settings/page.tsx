'use client'

import { Suspense, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useLocale } from 'next-intl'
import { signOut } from 'next-auth/react'
import { updatePreferences } from '@/actions/user/updatePreferences'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Locale } from '@/lib/preferences/types'
import ShippingSettings from './ShippingSettings'
import BoxSettings from './BoxSettings'

type Tab = 'user' | 'shipping' | 'boxes'
const tabs: Tab[] = ['user', 'shipping', 'boxes']

const SettingsContent = () => {
  const t = useTranslations('settings')
  const currentLocale = useLocale() as Locale
  const router = useRouter()
  const tabParam = useSearchParams().get('tab') as Tab | null
  const [activeTab, setActiveTab] = useState<Tab>(
    tabParam && tabs.includes(tabParam) ? tabParam : 'user',
  )

  const handleLocaleChange = async (locale: Locale) => {
    await updatePreferences({ locale })
    router.refresh()
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold mb-6">{t('title')}</h1>

      <div role="tablist" className="tabs tabs-border mb-6">
        <button
          role="tab"
          className={`tab ${activeTab === 'user' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('user')}
        >
          {t('tabs.user')}
        </button>
        <button
          role="tab"
          className={`tab ${activeTab === 'shipping' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('shipping')}
        >
          {t('tabs.shipping')}
        </button>
        <button
          role="tab"
          className={`tab ${activeTab === 'boxes' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('boxes')}
        >
          {t('tabs.boxes')}
        </button>
      </div>

      {activeTab === 'user' && (
        <div className="flex flex-col gap-6 max-w-md">
          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">{t('user.language')}</span>
            </label>
            <select
              className="select select-bordered w-full"
              value={currentLocale}
              onChange={(e) => handleLocaleChange(e.target.value as Locale)}
            >
              <option value="en">{t('user.english')}</option>
              <option value="es">{t('user.spanish')}</option>
            </select>
          </div>

          <div>
            <button
              className="btn btn-error btn-outline"
              onClick={() => signOut()}
            >
              {t('user.logout')}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'shipping' && <ShippingSettings />}
      {activeTab === 'boxes' && <BoxSettings />}
    </div>
  )
}

// useSearchParams needs a Suspense boundary in client pages
const SettingsPage = () => (
  <Suspense>
    <SettingsContent />
  </Suspense>
)

export default SettingsPage
