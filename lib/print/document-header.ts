import { docBadge, type DocKind } from './doc-badge'
import { escapeHtml } from './trip-common'
import { paymentTermPrintLabel } from '@/lib/payment-terms'
import type { PrintLang } from './print-i18n'

export function documentHeader(kind: DocKind): string {
  return `<div class="header"><div class="company-name">JohnstoneBros</div>${docBadge(kind)}<div class="company-addr">141 Slaney Close<br/>Dublin 11, D11 C3NX</div></div>`
}

export function paymentDetails(term: string | null | undefined, notes: (string | null | undefined)[], lang: PrintLang): string {
  const { label, immediate } = paymentTermPrintLabel(term ?? '', lang)
  const uniqueNotes = [...new Set(notes.filter((note): note is string => Boolean(note?.trim())))]
  return `${label ? `<div style="font-weight:bold;color:${immediate ? '#dc2626' : '#15803d'};">${escapeHtml(label)}</div>` : '—'}${uniqueNotes.map(note => `<div class="payment-note">${escapeHtml(note)}</div>`).join('')}`
}

/** Shared compact layout for customer-facing order documents. */
export const DOCUMENT_HEADER_CSS = `
.header { display:flex; align-items:center; gap:3mm; margin-bottom:2mm; padding-bottom:1.5mm; border-bottom:2px solid #1a3a2a; }
.header .company-name { font-size:23pt; font-weight:bold; font-style:italic; color:#1a3a2a; white-space:nowrap; }
.header .company-addr { margin-left:auto; text-align:right; font-size:6.5pt; line-height:1.2; color:#444; }
.info-table { margin-bottom:3mm; table-layout:fixed; }
.info-table td { padding:1mm 2mm; overflow-wrap:anywhere; }
.info-table .info-head { margin:-1mm -2mm 1mm; padding:1mm 2mm; border-bottom:1px solid #777; font-size:7pt; line-height:1; }
.info-table .info-val { font-size:8pt; line-height:1.25; }
.info-table .barcode-svg, .info-table .barcode-cell svg { height:10mm; max-width:100%; }
.info-table .barcode-code { font-size:8pt; margin-top:0.5mm; letter-spacing:0; }
.payment-note { margin-top:1mm; font-size:7.5pt; line-height:1.2; white-space:pre-wrap; }
`

/** Reserve room for the compact header; long external notes grow the info table. */
export function documentHeaderOverheadMm(notes: (string | null | undefined)[]): number {
  const lines = notes.filter(Boolean).reduce((sum, note) => sum + note!.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 30)), 0), 0)
  return 48 + Math.max(0, lines - 5) * 3.5
}
