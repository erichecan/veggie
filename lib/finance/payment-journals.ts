/** Fixed incoming-payment journals exposed by the invoice Register Payment flow. */
export const PAYMENT_JOURNALS = [
  { code: 'BANK', name: 'Bank (EUR)', type: 'BANK', accountCode: '1200', method: 'transfer', labelZh: 'Bank (EUR) · 银行转账', labelEn: 'Bank (EUR)' },
  { code: 'CHEQUE', name: 'Cheque (EUR)', type: 'BANK', accountCode: '1210', method: 'cheque', labelZh: 'Cheque (EUR) · 支票', labelEn: 'Cheque (EUR)' },
  { code: 'POS', name: 'POS Card (EUR)', type: 'CREDIT_CARD', accountCode: '1220', method: 'pos_card', labelZh: 'POS Card (EUR) · 刷卡', labelEn: 'POS Card (EUR)' },
  { code: 'CASH', name: 'Cash (EUR)', type: 'CASH', accountCode: '1205', method: 'cash', labelZh: 'Cash (EUR) · 现金', labelEn: 'Cash (EUR)' },
  { code: 'DIRECT_DEBIT', name: 'Direct Debit (EUR)', type: 'BANK', accountCode: '1230', method: 'direct_debit', labelZh: 'Direct Debit (EUR) · SEPA 直接扣款', labelEn: 'Direct Debit (EUR)' },
] as const

export type PaymentJournalCode = typeof PAYMENT_JOURNALS[number]['code']

export function paymentJournalByCode(code: string) {
  return PAYMENT_JOURNALS.find(journal => journal.code === code) ?? null
}

export function paymentJournalByMethod(method: string) {
  return PAYMENT_JOURNALS.find(journal => journal.method === method) ?? null
}
