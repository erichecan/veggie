import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { JwtPayload } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { writeLog } from '@/lib/action-log'
import { getObjectStore } from '@/lib/storage/object-store'
import { parseImageUrl, downloadProductImage } from '@/lib/product-image-url'
import type { ImageImportInput, ImageImportResult } from '@/lib/product-image-import'

interface Dependencies {
  db: Pick<typeof prisma,'product'>
  download: typeof downloadProductImage
  store: typeof getObjectStore
  log: typeof writeLog
}
export async function importImageUrls(req: Request,user: JwtPayload, overrides: Partial<Dependencies> = {}) {
  const {db,download,store,log}={db:prisma,download:downloadProductImage,store:getObjectStore,log:writeLog,...overrides}
  const denied=rateLimit(req,{id:'product-image-urls',max:600,windowMs:60000,keyFn:()=>user.userId})
  if(denied)return denied
  try {
    const body=await req.json()
    if(!['preview','import'].includes(body.action)||!Array.isArray(body.rows)||body.rows.length>(body.action==='preview'?2000:3))return NextResponse.json({error:'预览最多 2000 行，每次下载最多 3 行'},{status:400})
    if(body.rows.some((r:ImageImportInput)=>!r||!Number.isInteger(r.row)||typeof r.externalId!=='string'||typeof r.url!=='string'||typeof r.name!=='string'||r.externalId.length>300||r.url.length>4096||r.name.length>500))return NextResponse.json({error:'导入行格式不正确'},{status:400})
    const rows=body.rows as ImageImportInput[]
    const products=await db.product.findMany({where:{externalId:{in:rows.map(r=>r.externalId.trim()).filter(Boolean)}},select:{id:true,externalId:true,name:true,images:true}})
    const byId=new Map(products.map(p=>[p.externalId,p]))
    const counts=new Map<string,number>()
    for(const r of rows)if(r.url.trim())counts.set(r.externalId.trim(),(counts.get(r.externalId.trim())??0)+1)
    const results:ImageImportResult[]=[]
    for(const input of rows){
      const r={...input,externalId:input.externalId.trim(),url:input.url.trim()}
      const p=byId.get(r.externalId)
      const base={...r,productId:p?.id,productName:p?.name,existing:!!p?.images.length}
      if(!r.url){results.push({...base,status:'skipped',message:'图片链接为空，保留原图'});continue}
      if(!p){results.push({...base,status:'error',message:'External ID 未匹配到已有商品'});continue}
      if((counts.get(r.externalId)??0)>1){results.push({...base,status:'error',message:'同一商品有多条图片记录，请保留一条'});continue}
      try {parseImageUrl(r.url)}catch{results.push({...base,status:'error',message:'图片链接格式无效，仅支持公开 HTTP/HTTPS 图片链接'});continue}
      if(body.action==='preview'){results.push({...base,status:'ready'});continue}
      if(p.images.length && body.overwrite!==true){results.push({...base,status:'skipped',message:'已有图片，未选择覆盖'});continue}
      let stored:string|undefined
      try {
        const image=await download(r.url)
        const objectStore=store()
        const path=`products/${Date.now()}-${crypto.randomUUID()}.${image.ext}`
        const uploaded=await objectStore.put(path,image.buffer,image.contentType,{uploadedBy:user.userId})
        stored=path
        // Compare-and-set prevents overwriting images changed since the start of this request.
        const updated=await db.product.updateMany({where:{id:p.id,images:{equals:p.images}},data:{images:[uploaded.url]}})
        if(updated.count!==1)throw new Error('商品图片已被其他操作修改，请重新预览')
        stored=undefined
        results.push({...base,status:'done',message:'导入成功'})
      }catch(error){
        if(stored)await store().remove(stored).catch(()=>{})
        results.push({...base,status:'error',retryable:true,message:error instanceof Error?error.message:'图片导入失败，请重试'})
      }
    }
    if(body.action==='import')await log({userId:user.userId,userEmail:user.email,userName:user.name,action:'UPDATE',resource:'product',resourceId:'bulk-images',detail:`URL 图片导入：成功 ${results.filter(r=>r.status==='done').length}/${results.length}`})
    return NextResponse.json({results})
  }catch{ return NextResponse.json({error:'无法处理图片 URL 导入，请检查表格后重试'},{status:400}) }
}
