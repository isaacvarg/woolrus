import { createPackage } from "@/actions/orders/createPackage";
import { useData } from "@/store/dataSlice";
import { useOrder, useOrderActions } from "@/store/orderSlice";
import { usePackageActions } from "@/store/packageSlice";
import { LuRuler, LuWeight } from "react-icons/lu";
import { useTranslations } from "next-intl";
import Link from "next/link";

const PackageAdd = () => {
  const t = useTranslations('orderPacking')
  const { setView, clearSelectedPackage, openPackageDetails } = usePackageActions()
  const { setOrder } = useOrderActions()
  const { order } = useOrder()
  const { boxes } = useData()

  const handleAddPackage = async (boxId: string) => {
    if (!order) return
    const updatedOrder = await createPackage(order.id, boxId)
    setOrder(updatedOrder)
    const newPackage = updatedOrder.packages[updatedOrder.packages.length - 1]
    openPackageDetails(newPackage.id)
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <button onClick={() => {
          setView('display');
          clearSelectedPackage();
        }} className="btn btn-xl btn-secondary">{t('cancel')}</button>
      </div>

      {boxes.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-12 text-base-content/60 text-xl">
          {t('noBoxes')}
          <Link href="/settings?tab=boxes" className="btn btn-primary btn-lg">
            {t('goToBoxSettings')}
          </Link>
        </div>
      )}

      <div className="grid grid-cols-3 gap-6">

        {boxes.map(b => {
          return (
            <button
              key={b.id}
              onClick={() => handleAddPackage(b.id)}
              className="btn btn-outline btn-xl min-h-36 flex flex-col gap-2"
            >
              <div className="text-base-content text-2xl font-bold">
                {b.name}
              </div>
              <div className="text-base-content/60 flex gap-2 items-center text-xl font-semibold">
                <LuRuler className="size-6" />
                {`${b.length} x ${b.width} x ${b.height}`}
              </div>

              {b.maxWeight != null && (
                <div className="text-base-content/60 flex gap-2 items-center text-xl font-semibold">
                  <LuWeight className="size-6" />
                  {t('max', { weight: b.maxWeight })}
                </div>
              )}

            </button>
          )
        })}

      </div>

    </div>
  )
}

export default PackageAdd
