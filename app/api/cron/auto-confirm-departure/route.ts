import { POST as completeDeliveries } from '../auto-complete-delivery/route'

/** Backward compatible endpoint; the nightly job now completes, not only departs, ready waves. */
export async function POST(req: Request) {
  return completeDeliveries(req)
}
