import { parseCsv } from '@/lib/csv-export'

/** Shared first-sheet reader. Image import may prefer hyperlink targets over display labels. */
export async function readImportSheet(file: File, hyperlinks = false): Promise<string[][]> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(await file.arrayBuffer(), {type:'array'})
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) return []
    if (hyperlinks) for (const [key, cell] of Object.entries(sheet)) {
      if (!key.startsWith('!') && cell?.l?.Target) sheet[key] = {...cell,t:'s',v:cell.l.Target,w:cell.l.Target}
    }
    return XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,raw:false,defval:'',blankrows:hyperlinks}).map(r=>r.map(v=>v==null?'':String(v)))
  }
  return parseCsv(await file.text())
}
