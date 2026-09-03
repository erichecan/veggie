import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumber, parsePdfLines, detectCurrency, detectSupplier } from '../lib/purchase/pdf-line-parser'

describe('数字解析（欧陆小数逗号是这里唯一真正的坑）', () => {
  test('普通小数点', () => {
    assert.equal(parseNumber('12.50'), 12.5)
    assert.equal(parseNumber('€ 1.20'), 1.2)
  })

  test('欧陆写法：逗号是小数点', () => {
    assert.equal(parseNumber('1.234,56'), 1234.56)
    assert.equal(parseNumber('12,50'), 12.5)
  })

  test('英美写法：逗号是千分位', () => {
    assert.equal(parseNumber('1,234.56'), 1234.56)
  })

  test('单个逗号 + 3 位数 = 英式千分位（1,234 → 1234）', () => {
    assert.equal(parseNumber('1,234'), 1234)
  })

  test('⚠️ 单个点号 + 3 位数按**小数**读（1.000 → 1）—— 客户自家单据就把数量印成 1.000 意为 1 件', () => {
    assert.equal(parseNumber('1.000'), 1)
    assert.equal(parseNumber('2.000'), 2)
    // 代价：欧陆供应商写的 1.234（意为 1234）会被读成 1.234。
    // 这个歧义没有本地无关的解法，只能按客户所在地（爱尔兰）的约定取一边。
    assert.equal(parseNumber('1.234'), 1.234)
  })

  test('币种符号与空格不影响取值', () => {
    assert.equal(parseNumber('  $ 99 '), 99)
    assert.equal(parseNumber('£1,000.00'), 1000)
  })

  test('取不到数时返回 null，不返回 0 —— 0 会被当成真实价格', () => {
    assert.equal(parseNumber(''), null)
    assert.equal(parseNumber('N/A'), null)
    assert.equal(parseNumber('—'), null)
  })
})

describe('表头驱动解析', () => {
  const text = [
    'QTY \tUNIT \tDESCRIPTION \tPRICE \tVAT',
    '2.000 \tCASE \tTomato Cherry 250g \t12.50 \t0%',
    '3 \tKG \tPotato Rooster \t1,80 \t13.5%',
    'Subtotal \t€ 30.40',
    'Total \t€ 30.40',
  ].join('\n')

  test('按表头列序解析出商品行', () => {
    const r = parsePdfLines(text)
    assert.equal(r.error, null)
    assert.equal(r.diagnostics.strategy, 'header')
    assert.equal(r.lines.length, 2)
    assert.equal(r.lines[0].productName, 'Tomato Cherry 250g')
    assert.equal(r.lines[0].quantity, 2)
    assert.equal(r.lines[0].unitCost, 12.5)
    assert.equal(r.lines[0].uom, 'CASE')
  })

  test('欧陆小数在表格里同样正确（1,80 = 1.8）', () => {
    const r = parsePdfLines(text)
    assert.equal(r.lines[1].unitCost, 1.8)
  })

  test('⛔ 合计行不能变成商品（否则采购单里会多一个叫 Subtotal 的货）', () => {
    const r = parsePdfLines(text)
    assert.ok(!r.lines.some(l => /total/i.test(l.productName)), '合计行混进商品了')
    assert.ok(r.diagnostics.skippedTotals >= 2, `应跳过合计/总计行，实际 ${r.diagnostics.skippedTotals}`)
  })

  test('每行都保留原文，便于人工核对', () => {
    const r = parsePdfLines(text)
    assert.ok(r.lines[0].raw.includes('Tomato Cherry'))
  })

  test('中文表头也认', () => {
    const r = parsePdfLines([
      '数量\t单位\t品名\t单价',
      '5\t箱\t上海青\t8.60',
    ].join('\n'))
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].productName, '上海青')
    assert.equal(r.lines[0].quantity, 5)
    assert.equal(r.lines[0].unitCost, 8.6)
  })
})

describe('模式兜底（认不出表头时）', () => {
  test('一行里有文字 + 两个数就当商品行', () => {
    const r = parsePdfLines([
      'Supplier Quotation 2026-08-01',
      'Carrot Loose 10 0.95',
      'Onion Bag 5 2.30',
    ].join('\n'))
    assert.equal(r.diagnostics.strategy, 'pattern')
    assert.equal(r.lines.length, 2)
    assert.equal(r.lines[0].quantity, 10)
    assert.equal(r.lines[0].unitCost, 0.95)
  })

  test('⛔「数量 单价 小计」时取单价而不是小计（靠验算 15×5=75，不靠猜位置）', () => {
    const r = parsePdfLines(['Tomato Cherry 15 5.00 75.00'].join('\n'))
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].quantity, 15)
    assert.equal(r.lines[0].unitCost, 5, '取成 75 就是把小计当单价了')
  })

  test('⚠️ 已知限制：品名里带数字时兜底模式会把它当数量（表头模式不受影响）', () => {
    const r = parsePdfLines(['Tomato Cherry 250g 15 5.00 75.00'].join('\n'))
    assert.equal(r.lines[0].quantity, 250, '这是记录现状，不是期望行为')
    // 有表头时按列取值，品名里的数字不会干扰
    const withHeader = parsePdfLines([
      'QTY\tDESCRIPTION\tPRICE',
      '15\tTomato Cherry 250g\t5.00',
    ].join('\n'))
    assert.equal(withHeader.lines[0].quantity, 15)
    assert.equal(withHeader.lines[0].unitCost, 5)
  })

  test('验算不成立时仍取最后一个数（说明那不是「数量×单价=小计」的排布）', () => {
    const r = parsePdfLines(['Carrot 10 3 0.95'].join('\n'))
    assert.equal(r.lines[0].unitCost, 0.95)
  })

  test('只有一个数的行不当商品（页码/电话/日期）', () => {
    const r = parsePdfLines([
      'Page 1',
      'Tel: 018308065',
      'Carrot 10 0.95',
    ].join('\n'))
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].productName.includes('Carrot'), true)
  })

  test('⛔ 20260902 实测（真实供应商发票 Valstar Holland）：页码/银行账号/税号不能混进商品行', () => {
    // 这几行原样摘自 pdf-parse 抽出的文字层——注意 "Page: 1/1" 挤在同一行文字末尾，
    // 不是独占一行；银行信息行同样满足"文字+两个数"的兜底门槛，不专门排除会被当成商品。
    const r = parsePdfLines([
      'Sales Invoice \tPage: 1/1',
      '60 \tAvocado Hass RTE 18 \t16,75 \t1.005,00',
      'Account no. 112738397 / IBAN NL93ABNA0112738397 / Swift code ABNANL2A / VAT NL001571229B01 / COC no. 27208643 / GLN no. 8718367999913',
    ].join('\n'))
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].productName.includes('Avocado'), true)
  })
})

describe('失败时必须明确报错，不能静默出空表', () => {
  test('空文字层 → 明说是扫描件', () => {
    const r = parsePdfLines('')
    assert.equal(r.lines.length, 0)
    assert.match(r.error ?? '', /没有文字层|扫描/)
  })

  test('有文字但认不出商品行 → 报出扫了多少行、跳过多少合计行', () => {
    const r = parsePdfLines(['Dear customer,', 'Thanks for your enquiry.', 'Best regards'].join('\n'))
    assert.equal(r.lines.length, 0)
    assert.ok(r.error && r.error.length > 0, '必须给出可读的失败原因')
    assert.match(r.error ?? '', /扫描了 3 行/)
    assert.equal(r.diagnostics.strategy, 'none')
  })

  test('解析成功时 error 为 null（调用方据此判断）', () => {
    const r = parsePdfLines('QTY\tDESCRIPTION\tPRICE\n1\tApple\t2.00')
    assert.equal(r.error, null)
    assert.equal(r.diagnostics.matchedLines, 1)
  })
})

describe('折行合并（真实 PDF 里最常见的形态）', () => {
  // 客户那份单据的文字层就是这个样子：品名换行、价格被挤到下一行
  const wrapped = [
    'QTY 	UNIT 	DESCRIPTION 	PRICE 	VAT 	INCL VAT',
    '1.000 	LOOSE 	Courgette LOOSE',
    '角瓜',
    '1.20 	0% 	€ 1.20',
    'Subtotal 	€ 1.20',
  ].join('\n')

  test('被挤到下一行的单价能接回来（否则单价永远是 null）', () => {
    const r = parsePdfLines(wrapped)
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].quantity, 1)
    assert.equal(r.lines[0].unitCost, 1.2)
    assert.equal(r.lines[0].uom, 'LOOSE')
  })

  test('换行的品名接到一起（中英文都保留）', () => {
    const r = parsePdfLines(wrapped)
    assert.match(r.lines[0].productName, /Courgette/)
    assert.match(r.lines[0].productName, /角瓜/)
  })

  test('⛔ 续行不能把下一条商品吃掉', () => {
    const r = parsePdfLines([
      'QTY	UNIT	DESCRIPTION	PRICE',
      '2	CASE	Apple',
      '3.50',
      '5	BOX	Banana',
      '1.20',
    ].join('\n'))
    assert.equal(r.lines.length, 2)
    assert.equal(r.lines[0].unitCost, 3.5)
    assert.equal(r.lines[1].quantity, 5)
    assert.equal(r.lines[1].unitCost, 1.2)
  })
})

describe('表头两词挤一格 / 单号干扰（都是实测撞到的）', () => {
  test('`QTY UNIT | DESCRIPTION | UNIT COST | VAT | TOTAL` 这种表头要认得出来', () => {
    const r = parsePdfLines([
      'QTY UNIT \tDESCRIPTION \tUNIT COST \tVAT \tTOTAL',
      '15.000 \tRed Heera Peanut Butter 340g Jar \t€5.00 \t0% \t€75.00',
      'Subtotal \t€75.00',
    ].join('\n'))
    assert.equal(r.diagnostics.strategy, 'header', '认不出表头就会退化到兜底模式，单价取成小计')
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].quantity, 15)
    assert.equal(r.lines[0].unitCost, 5, '取成 75 说明把 TOTAL 当成单价了')
  })

  test('`UNIT COST` 不能被当成「单位」列（price 优先于 uom）', () => {
    const r = parsePdfLines([
      'QTY \tDESCRIPTION \tUNIT COST',
      '3 \tApple \t2.50',
    ].join('\n'))
    assert.equal(r.lines[0].unitCost, 2.5)
  })

  test('单据编号不能被兜底模式当成商品', () => {
    const r = parsePdfLines([
      'F2-PO-1786510544939',
      'Carrot Loose 10 0.95',
    ].join('\n'))
    assert.equal(r.lines.length, 1)
    assert.match(r.lines[0].productName, /Carrot/)
  })
})

describe('币种识别（20260819：不再依赖 AI）', () => {
  test('欧元符号 → EUR', () => {
    assert.equal(detectCurrency('Total € 1.20'), 'EUR')
  })

  test('ISO 码优先于符号 —— $ 可能是 USD/CAD/AUD，写了 CAD 就以它为准', () => {
    assert.equal(detectCurrency('Amount: CAD $120.00'), 'CAD')
  })

  test('RMB 归一到 CNY', () => {
    assert.equal(detectCurrency('金额 RMB 800'), 'CNY')
  })

  test('认不出就是 null，不瞎猜', () => {
    assert.equal(detectCurrency('Carrot 10 0.95'), null)
  })
})

describe('供应商识别（20260819：不再依赖 AI）', () => {
  const SUPPLIERS = [
    { id: 's1', name: 'Dublin Veg Wholesale' },
    { id: 's2', name: 'Asia Foods' },
    { id: 's3', name: 'Asia Foods Dublin' },
    { id: 's4', name: 'AB' },
  ]

  test('系统已有供应商名出现在正文里 → 直接给 id', () => {
    const r = detectSupplier('Quotation from Dublin Veg Wholesale\nCarrot 10 0.95', SUPPLIERS)
    assert.equal(r.id, 's1')
  })

  test('多个命中取名字最长的（更具体那个）', () => {
    const r = detectSupplier('Invoice — Asia Foods Dublin Ltd', SUPPLIERS)
    assert.equal(r.id, 's3')
  })

  test('带标签但库里没有 → 回报名字、id 为 null，让人手选', () => {
    const r = detectSupplier('Supplier: Fresh Iberia SL', SUPPLIERS)
    assert.equal(r.id, null)
    assert.equal(r.name, 'Fresh Iberia SL')
  })

  test('中文标签也认', () => {
    assert.equal(detectSupplier('供应商：山东蔬菜公司', []).name, '山东蔬菜公司')
  })

  test('⛔ 过短的供应商名不参与正文扫描，否则任意片段都能命中', () => {
    const r = detectSupplier('Carrot ABC 10 0.95', SUPPLIERS)
    assert.equal(r.id, null)
  })

  test('⛔ 不拿第一行当供应商 —— 那通常是客户自己的抬头', () => {
    const r = detectSupplier('Johnstone Bros\nCarrot 10 0.95', SUPPLIERS)
    assert.equal(r.id, null)
    assert.equal(r.name, null)
  })
})

describe('parsePdfLines 一并返回币种与供应商', () => {
  test('解析成功时带上识别结果', () => {
    const r = parsePdfLines(
      ['Supplier: Dublin Veg Wholesale', 'QTY \tDESCRIPTION \tUNIT COST', '3 \tApple \t€2.50'].join('\n'),
      { suppliers: [{ id: 's1', name: 'Dublin Veg Wholesale' }] },
    )
    assert.equal(r.currency, 'EUR')
    assert.equal(r.supplierId, 's1')
    assert.equal(r.lines.length, 1)
  })

  test('解析失败时也要带上（供应商/币种是独立线索，不该被行解析失败连累）', () => {
    const r = parsePdfLines('Supplier: Fresh Iberia SL\n€ nothing parsable here')
    assert.equal(r.lines.length, 0)
    assert.equal(r.currency, 'EUR')
    assert.equal(r.supplierName, 'Fresh Iberia SL')
  })

  test('空文字层也不抛错', () => {
    const r = parsePdfLines('')
    assert.equal(r.currency, null)
    assert.equal(r.supplierId, null)
  })
})
