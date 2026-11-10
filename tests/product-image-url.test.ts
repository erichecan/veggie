import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseImageImportTable } from '../lib/product-image-import'
import { isPublicImageAddress, parseImageUrl, downloadProductImage, imageFormat } from '../lib/product-image-url'

test('screenshot column names, external IDs, blank image rows and row numbers',()=>{
  assert.deepEqual(parseImageImportTable([['External ID','Name','Image'],['hy.product.template.201','Rice','http://161.35.45.154/jpg/rice.jpg'],['hy.product.template.202','Rice 2',''],['','',''],['hy.product.template.203','Noodle','https://example.com/a.png']]),[
    {row:2,externalId:'hy.product.template.201',name:'Rice',url:'http://161.35.45.154/jpg/rice.jpg'},
    {row:3,externalId:'hy.product.template.202',name:'Rice 2',url:''},
    {row:5,externalId:'hy.product.template.203',name:'Noodle',url:'https://example.com/a.png'},
  ])
  assert.throws(()=>parseImageImportTable([['Name','Image']]),/External ID/)
})
test('allows public HTTP URLs and rejects credentials, non-web schemes and unexpected ports',()=>{
  assert.equal(parseImageUrl('http://161.35.45.154/jpg/a.jpg').protocol,'http:')
  for(const url of ['file:///etc/passwd','ftp://example.com/a.jpg','https://user:pass@example.com/a.jpg','http://example.com:8080/a'])assert.throws(()=>parseImageUrl(url))
})
test('public address checks reject internal, metadata, mapped IPv6 and non-global networks',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.0.1','192.168.1.1','100.100.100.200','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(isPublicImageAddress(address),false,address)
  assert.equal(isPublicImageAddress('161.35.45.154'),true)
  assert.equal(isPublicImageAddress('2606:4700:4700::1111'),true)
})
test('network downloader refuses private targets before issuing HTTP requests',async()=>{
  await assert.rejects(downloadProductImage('http://127.0.0.1/secret'),/公开网络/)
  await assert.rejects(downloadProductImage('http://[::1]/secret'),/公开网络/)
})
test('validates file signatures instead of trusting a .jpg filename or Content-Type',()=>{
  assert.equal(imageFormat(Buffer.from([255,216,255,0])).ext,'jpg')
  assert.equal(imageFormat(Buffer.from([137,80,78,71,13,10,26,10])).ext,'png')
  assert.equal(imageFormat(Buffer.from('GIF89a...')).ext,'gif')
  assert.equal(imageFormat(Buffer.from('RIFF1234WEBP')).ext,'webp')
  assert.throws(()=>imageFormat(Buffer.from('<html>not an image</html>')),/不是/)
})
