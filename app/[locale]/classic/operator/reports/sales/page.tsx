'use client'

import { Card, CardContent } from '@/components/ui/card'
import { ReportingProvider } from '@/components/reporting/ReportingContext'
import { ReportingToolbar } from '@/components/reporting/ReportingToolbar'
import { ReportView } from '@/components/reporting/ReportView'

export default function SalesReportPage() {
  return (
    <ReportingProvider reportType="sales">
      <div className="space-y-4 p-4">
        <h1 className="text-lg font-semibold">销售分析</h1>
        <Card>
          <CardContent className="p-4 space-y-4">
            <ReportingToolbar />
            <ReportView />
          </CardContent>
        </Card>
      </div>
    </ReportingProvider>
  )
}
