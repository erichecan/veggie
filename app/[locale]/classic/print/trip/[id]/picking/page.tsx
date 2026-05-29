import TripPrintClient from '../_TripPrintClient'

export default function TripPickingPrintPage({ params }: { params: Promise<{ id: string }> }) {
  return <TripPrintClient params={params} type="picking" />
}
