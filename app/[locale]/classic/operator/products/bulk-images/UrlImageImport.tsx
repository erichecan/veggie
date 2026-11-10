'use client'
import { useState } from 'react'
import { apiPost } from '@/lib/api'
import { downloadCsv } from '@/lib/csv-export'
import { readImportSheet } from '@/lib/read-import-sheet'
import { parseImageImportTable, type ImageImportResult } from '@/lib/product-image-import'

export default function UrlImageImport({isEn}:{isEn:boolean}) {
  const [rows,setRows]=useState<ImageImportResult[]>([])
  const [busy,setBusy]=useState(false)
  const [overwrite,setOverwrite]=useState(false)
  const [error,setError]=useState('')
  const [progress,setProgress]=useState('')
  const [filename,setFilename]=useState('')
  const label=(en:string,zh:string)=>isEn?en:zh
  async function preview(file:File) {
    setBusy(true);setError('');setRows([]);setProgress('');setFilename(file.name);setOverwrite(false)
    try {
      if(file.size>10*1024*1024)throw new Error(label('File must be under 10MB','文件不能超过 10MB'))
      const input=parseImageImportTable(await readImportSheet(file,true))
      if(!input.length)throw new Error(label('No image records found','表格没有图片记录'))
      const data=await apiPost<{results:ImageImportResult[]}>('/api/products/bulk-images',{action:'preview',rows:input})
      setRows(data.results)
    }catch(e){setError(e instanceof Error?e.message:label('Preview failed','预览失败'))}finally{setBusy(false)}
  }
  async function run() {
    const targets=rows.filter(r=>(r.status==='ready'||(r.status==='error'&&r.retryable))&&r.productId&&r.url&&(overwrite||!r.existing))
    if(!targets.length)return
    setBusy(true);setError('');setProgress('')
    try{
      for(let i=0;i<targets.length;i+=3){
        const chunk=targets.slice(i,i+3)
        const data=await apiPost<{results:ImageImportResult[]}>('/api/products/bulk-images',{action:'import',rows:chunk,overwrite})
        const result=new Map(data.results.map(r=>[r.row,r]))
        setRows(prev=>prev.map(r=>result.get(r.row)??r))
        setProgress(`${Math.min(i+3,targets.length)} / ${targets.length}`)
      }
    }catch(e){setError(e instanceof Error?e.message:label('Import failed. You may retry remaining rows.','导入中断，可重试剩余行'))}finally{setBusy(false)}
  }
  const count=rows.filter(r=>(r.status==='ready'||(r.status==='error'&&r.retryable))&&r.productId&&r.url&&(overwrite||!r.existing)).length
  return <section className="space-y-3 rounded-lg border border-gray-200 p-4 mb-6">
    <h2 className="font-semibold">{label('Import image URLs from spreadsheet','从表格导入图片 URL')}</h2>
    <p className="text-sm text-gray-600">{label('CSV / Excel: External ID, Name (optional), Image. Match existing products by External ID. Blank URLs keep current images. Images are downloaded into system storage.','支持 CSV / Excel：External ID、Name（可选）、Image。按 External ID 匹配已有商品；空链接保留原图；图片下载后保存到系统存储。')}</p>
    <div className="flex flex-wrap gap-3 items-center">
      <input aria-label={label('Select image URL spreadsheet','选择图片 URL 表格')} type="file" accept=".csv,.xlsx,.xls" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void preview(f);e.target.value=''}} className="max-w-full text-sm" />
      <button className="border rounded px-3 py-2 text-sm" disabled={busy} onClick={()=>downloadCsv('product-image-urls',['External ID','Name','Image'],[['hy.product.template.201','Example product','https://example.com/product.jpg']])}>{label('Download template','下载模板')}</button>
    </div>
    {filename&&<p className="text-sm text-gray-500">{filename}</p>}
    {rows.length>0&&<>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overwrite} disabled={busy} onChange={e=>setOverwrite(e.target.checked)}/>{label('Replace existing images (one image per product)','覆盖已有图片（每个商品保存一张新图）')}</label>
      <p className="text-sm text-gray-600">{label('Preview only matches products; URL downloads are validated during import.','预览仅核对商品匹配；图片链接是否可下载会在导入时校验。')} {rows.filter(r=>r.status==='done').length} {label('imported','行已成功')} · {rows.filter(r=>r.status==='error').length} {label('errors','行错误')}</p>
      <div className="max-h-96 overflow-auto border rounded"><table className="w-full text-sm text-left"><thead className="sticky top-0 bg-gray-50"><tr>{['#','External ID',label('Matched product / file name','匹配商品 / 表格名称'),'Image',label('Result','结果')].map(h=><th key={h} className="p-2 whitespace-nowrap">{h}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.row} className="border-t align-top"><td className="p-2">{r.row}</td><td className="p-2 break-all min-w-32">{r.externalId}</td><td className="p-2 min-w-44"><div>{r.productName||'—'}</div>{r.name&&<div className={`text-xs ${r.productName&&r.name!==r.productName?'text-amber-700':'text-gray-500'}`}>{r.name}</div>}</td><td className="p-2 max-w-64 break-all">{r.url||'—'}</td><td className={`p-2 min-w-40 ${r.status==='error'?'text-red-700':r.status==='done'?'text-green-700':'text-gray-600'}`}>{r.message||(r.existing?label(overwrite?'Will replace existing image':'Existing image — skipped',overwrite?'将覆盖原图':'已有图片，将跳过'):label('Ready to import','待导入'))}</td></tr>)}</tbody></table></div>
      <button disabled={busy||count===0} onClick={()=>void run()} className="px-4 py-2 rounded text-white bg-[#875A7B] disabled:opacity-40">{busy?label('Processing…','处理中…'):label(`Import / retry ${count} rows`,`导入 / 重试 ${count} 行`)}</button>
    </>}
    {progress&&<p role="status" className="text-sm">{progress}</p>}
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>
}
