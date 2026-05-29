'use client'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import dynamic from 'next/dynamic'
import OdooControlPanel from '@/components/classic/OdooControlPanel'

const BatchAnalysis = dynamic(() => import('@/components/shared/BatchAnalysis'), { ssr: false })

export default function BatchAnalysisPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  return (
    <div>
      <OdooControlPanel
        breadcrumb={['配送', '配送行程', '批次路线分析']}
        permanentActions={[
          {
            label: '返回行程',
            onClick: () => router.push(`${prefix}/classic/operator/trips`),
          },
        ]}
        searchValue=""
        onSearch={() => {}}
      />
      <BatchAnalysis />
    </div>
  )
}
