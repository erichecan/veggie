import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importImageUrls } from '../lib/product-image-url-import'
import { readImportSheet } from '../lib/read-import-sheet'
import * as XLSX from 'xlsx'

function setup(fail=false) {
  const products=[{id:'p1',externalId:'hy.product.template.201',name:'Rice',images:[] as string[]},{id:'p2',externalId:'hy.product.template.202',name:'Noodles',images:['/old.jpg']}]
  const calls={download:0,put:0,remove:0}
  const overrides={db:{product:{findMany:async()=>products,updateMany:async({where,data}:any)=>{const p=products.find(p=>p.id===where.id)!;p.images=data.images;return {count:1}}}},download:async()=>{calls.download++;if(fail)throw new Error('HTTP 404');return {buffer:Buffer.from([255,216,255]),ext:'jpg',contentType:'image/jpeg'}},store:()=>({put:async()=>{calls.put++;return {url:'/new.jpg'}},remove:async()=>{calls.remove++}}),log:async()=>{}}
  const user={userId:crypto.randomUUID(),email:'test@local.invalid',name:'Test',role:'BOSS'}
  const call=async(action:string,rows:any[],overwrite=false)=>{
    const req=new Request('http://localhost/api/products/bulk-images',{method:'POST',body:JSON.stringify({action,rows,overwrite})})
    const r=await importImageUrls(req,user,overrides as never)
    assert.equal(r.status,200);return (await r.json()).results
  }
  const row=(externalId:string,url='http://example.com/a.jpg',n=2)=>({row:n,externalId,name:'From spreadsheet',url})
  return {products,calls,call,row,overrides}
}
test('preview matches by External ID without fetching or modifying images; flags duplicates and missing products',async()=>{
  const s=setup()
  const r=await s.call('preview',[s.row('hy.product.template.201'),s.row('missing','',3),s.row('unknown','http://example.com/a.jpg',4),s.row('hy.product.template.202','http://example.com/a.jpg',5)])
  assert.deepEqual(r.map((x:any)=>x.status),['ready','skipped','error','ready'])
  assert.equal(r[0].productId,'p1');assert.equal(r[3].existing,true);assert.equal(s.calls.download,0);assert.equal(s.calls.put,0)
  const duplicate=await s.call('preview',[s.row('hy.product.template.201'),s.row('hy.product.template.201','http://example.com/b.jpg',3)])
  assert.deepEqual(duplicate.map((x:any)=>x.status),['error','error'])
})
test('import skips existing images unless explicitly overwritten; empty URLs preserve images',async()=>{
  const s=setup();const rows=[s.row('hy.product.template.201'),s.row('hy.product.template.202','http://example.com/b.jpg',3)]
  const r=await s.call('import',rows)
  assert.deepEqual(r.map((x:any)=>x.status),['done','skipped']);assert.equal(s.calls.put,1);assert.deepEqual(s.products[1].images,['/old.jpg'])
  await s.call('import',[s.row('hy.product.template.202')],true)
  assert.deepEqual(s.products[1].images,['/new.jpg'])
  await s.call('import',[s.row('hy.product.template.202','')],true)
  assert.deepEqual(s.products[1].images,['/new.jpg']);assert.equal(s.calls.put,2)
})
test('download failure preserves the original image and returns a retryable error',async()=>{
  const s=setup(true);const r=await s.call('import',[s.row('hy.product.template.202')],true)
  assert.equal(r[0].status,'error');assert.equal(r[0].retryable,true);assert.deepEqual(s.products[1].images,['/old.jpg']);assert.equal(s.calls.put,0)
})
test('Excel reader imports hyperlink targets instead of display text',async()=>{
  const wb=XLSX.utils.book_new();const sheet=XLSX.utils.aoa_to_sheet([['External ID','Name','Image'],['hy.product.template.201','Rice','View image']])
  sheet.C2.l={Target:'http://example.com/rice.jpg'}
  XLSX.utils.book_append_sheet(wb,sheet,'Products')
  const file=new File([XLSX.write(wb,{type:'array',bookType:'xlsx'})],'images.xlsx')
  assert.equal((await readImportSheet(file,true))[1][2],'http://example.com/rice.jpg')
  assert.equal((await readImportSheet(file))[1][2],'View image')
})

test('database conflict removes the newly stored image and leaves the original image intact',async()=>{
  const s=setup()
  s.overrides.db.product.updateMany=async()=>({count:0})
  const result=await s.call('import',[s.row('hy.product.template.202')],true)
  assert.equal(result[0].status,'error')
  assert.deepEqual(s.products[1].images,['/old.jpg'])
  assert.equal(s.calls.put,1);assert.equal(s.calls.remove,1)
})
