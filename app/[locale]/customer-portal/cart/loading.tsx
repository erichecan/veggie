export default function CartLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-4" aria-live="polite">
      <div className="h-7 w-40 animate-pulse rounded bg-gray-200" />
      <div className="h-28 animate-pulse rounded-2xl border border-[#dce7d9] bg-white" />
      <div className="h-28 animate-pulse rounded-2xl border border-[#dce7d9] bg-white" />
      <div className="h-28 animate-pulse rounded-2xl border border-[#dce7d9] bg-white" />
    </div>
  )
}
