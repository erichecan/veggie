import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { LookupAddress } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const blocked = new BlockList()
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(ip,prefix,'ipv4')
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked.addSubnet(ip,prefix,'ipv6')
// Only global-unicast IPv6; exclude documentation, transition and mapped ranges.
export function isPublicImageAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !blocked.check(ip,'ipv4')
  return isIP(ip) === 6 && /^[23]/i.test(ip) && !blocked.check(ip,'ipv6')
}
export function parseImageUrl(raw: string): URL {
  const url = new URL(raw)
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('仅支持公开 HTTP/HTTPS 图片链接（80/443 端口），不支持登录凭据')
  return url
}
export function imageFormat(buffer: Buffer): { contentType: string; ext: string } {
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {contentType:'image/png',ext:'png'}
  if (buffer.length >= 3 && buffer[0]===255 && buffer[1]===216 && buffer[2]===255) return {contentType:'image/jpeg',ext:'jpg'}
  if (['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString())) return {contentType:'image/gif',ext:'gif'}
  if (buffer.length >= 12 && buffer.subarray(0,4).toString()==='RIFF' && buffer.subarray(8,12).toString()==='WEBP') return {contentType:'image/webp',ext:'webp'}
  throw new Error('链接内容不是 JPG、PNG、WebP 或 GIF 图片')
}
export async function downloadProductImage(raw: string) {
  const controller = new AbortController()
  const timer = setTimeout(()=>controller.abort(),15000)
  try {
    let url = parseImageUrl(raw)
    for (let hop=0; hop<=3; hop++) {
      const host=url.hostname.replace(/^\[|\]$/g,'')
      const addresses = await new Promise<LookupAddress[]>((resolve,reject)=>{
        const abort=()=>reject(new Error('图片下载超时'))
        if(controller.signal.aborted){abort();return}
        controller.signal.addEventListener('abort',abort,{once:true})
        lookup(host,{all:true}).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort))
      })
      if (controller.signal.aborted) throw new Error('图片下载超时')
      if (!addresses.length || addresses.some(a=>!isPublicImageAddress(a.address))) throw new Error('图片链接必须指向公开网络地址')
      const address=addresses[0]
      const result = await new Promise<{buffer?:Buffer;location?:string}>((resolve,reject)=>{
        // Pin the validated DNS result to prevent DNS rebinding; retain original hostname for TLS verification.
        const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
          signal:controller.signal, family:address.family,
          lookup:((_hostname:unknown,_options:unknown,cb: (...args:unknown[])=>void)=> cb(null,address.address,address.family)) as never,
          headers:{Accept:'image/jpeg,image/png,image/webp,image/gif','User-Agent':'Veggie-Product-Image-Import/1.0'},
        },res=>{
          const status=res.statusCode??0
          if ([301,302,303,307,308].includes(status) && res.headers.location) {res.destroy();resolve({location:res.headers.location});return}
          if (status!==200) {res.destroy();reject(new Error(`图片服务器返回 HTTP ${status}`));return}
          if (Number(res.headers['content-length']??0)>5*1024*1024) {res.destroy();reject(new Error('图片大小不能超过 5MB'));return}
          const chunks:Buffer[]=[];let size=0
          res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>5*1024*1024){res.destroy(new Error('图片大小不能超过 5MB'));return}chunks.push(chunk)})
          res.on('end',()=>resolve({buffer:Buffer.concat(chunks)}));res.on('error',reject)
        })
        req.on('error',reject);req.end()
      })
      if(result.location){url=parseImageUrl(new URL(result.location,url).href);continue}
      const buffer=result.buffer!
      return {buffer,...imageFormat(buffer)}
    }
    throw new Error('图片链接重定向次数过多')
  } catch(error) {
    if(controller.signal.aborted) throw new Error('图片下载超时，请重试')
    throw error
  } finally {clearTimeout(timer)}
}
