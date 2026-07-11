'use client'

/** 创建页右侧 PDF 侧栏查看器——像抽屉一样和表单左右分屏，方便对照原文件填单 */
export default function PdfSidePanel({
  url,
  name,
  onClose,
}: {
  url: string
  name: string
  onClose: () => void
}) {
  return (
    <div className="w-[42%] min-w-[360px] max-w-[560px] flex-shrink-0 border-l border-gray-200 bg-white flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 flex-shrink-0">
        <span className="text-xs text-gray-600 truncate" title={name}>{name}</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm flex-shrink-0 ml-2">
          收起 ✕
        </button>
      </div>
      <iframe src={url} className="flex-1 w-full" title={name} />
    </div>
  )
}
