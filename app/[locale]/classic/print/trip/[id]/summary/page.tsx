import TripPrintClient from '../_TripPrintClient'

export default function TripSummaryPrintPage({ params }: { params: Promise<{ id: string }> }) {
  return <TripPrintClient params={params} type="summary" />
}
