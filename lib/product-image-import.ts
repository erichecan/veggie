export interface ImageImportInput { row: number; externalId: string; name: string; url: string }
export interface ImageImportResult extends ImageImportInput { productId?: string; productName?: string; existing?: boolean; retryable?: boolean; status:'ready'|'skipped'|'error'|'done'; message?: string }
export function parseImageImportTable(table: string[][]): ImageImportInput[] {
  const headers=(table[0]??[]).map(v=>v.replace(/^\uFEFF/,'').trim().toLowerCase().replace(/[ _-]/g,''))
  const id=headers.findIndex(v=>['externalid','id','外部id','外部编号'].includes(v))
  const name=headers.findIndex(v=>['name','productname','名称','商品名称'].includes(v))
  const image=headers.findIndex(v=>['image','imageurl','图片','图片链接','图片url'].includes(v))
  if(id<0||image<0) throw new Error('表格必须包含 External ID 和 Image 列（Name 可选）')
  return table.slice(1).map((r,i)=>({row:i+2,externalId:(r[id]??'').trim(),name:name<0?'':(r[name]??'').trim(),url:(r[image]??'').trim()})).filter(r=>r.externalId||r.name||r.url)
}
