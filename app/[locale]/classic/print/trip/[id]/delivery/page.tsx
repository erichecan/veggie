import TripPrintClient from '../_TripPrintClient'

export default function TripDeliveryPrintPage({ params }: { params: Promise<{ id: string }> }) {
  return <TripPrintClient params={params} type="delivery" />
}
