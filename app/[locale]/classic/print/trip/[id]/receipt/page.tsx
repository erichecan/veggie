import TripPrintClient from '../_TripPrintClient'

export default function TripReceiptPrintPage({ params }: { params: Promise<{ id: string }> }) {
  return <TripPrintClient params={params} type="receipt" />
}
