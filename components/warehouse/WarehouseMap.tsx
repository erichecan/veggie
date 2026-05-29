'use client'

interface WarehouseMapProps {
  highlightZones?: string[]
  className?: string
}

const ZONE_STYLES: Record<string, { fill: string; activeFill: string; stroke: string; activeStroke: string; label: string; textColor: string; activeText: string }> = {
  '叶菜区': {
    fill: '#dcfce7', activeFill: '#16a34a', stroke: '#86efac', activeStroke: '#15803d',
    label: '🥬 叶菜区', textColor: '#16a34a', activeText: '#ffffff',
  },
  '根茎区': {
    fill: '#fef3c7', activeFill: '#d97706', stroke: '#fcd34d', activeStroke: '#b45309',
    label: '🥕 根茎区', textColor: '#b45309', activeText: '#ffffff',
  },
  '菌菇区': {
    fill: '#ede9fe', activeFill: '#7c3aed', stroke: '#c4b5fd', activeStroke: '#6d28d9',
    label: '🍄 菌菇区', textColor: '#7c3aed', activeText: '#ffffff',
  },
  '配送区': {
    fill: '#fee2e2', activeFill: '#dc2626', stroke: '#fca5a5', activeStroke: '#b91c1c',
    label: '🚚 配送区', textColor: '#dc2626', activeText: '#ffffff',
  },
}

export function WarehouseMap({ highlightZones = [], className = '' }: WarehouseMapProps) {
  const hl = (zone: string) => highlightZones.includes(zone)

  return (
    <div className={`relative ${className}`}>
      <svg viewBox="0 0 560 370" className="w-full" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <defs>
          <style>{`
            @keyframes wh-pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.65; }
            }
            .wh-active { animation: wh-pulse 1.4s ease-in-out infinite; }
          `}</style>
        </defs>

        {/* 外框 */}
        <rect x="0" y="0" width="560" height="370" fill="#f8fafc" rx="8" />
        <rect x="3" y="3" width="554" height="364" fill="none" stroke="#cbd5e1" strokeWidth="2" rx="7" />

        {/* ── 包装盒区（顶部横条）── */}
        <rect x="10" y="10" width="540" height="65" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.5" rx="5" />
        <text x="280" y="36" textAnchor="middle" fill="#475569" fontSize="13" fontWeight="700">📦 包装盒区</text>
        <text x="280" y="54" textAnchor="middle" fill="#94a3b8" fontSize="10">包装材料·纸箱存放</text>

        {/* ── 分拣台（左侧中区）── */}
        <rect x="10" y="85" width="175" height="200" fill="#faf5ff" stroke="#c4b5fd" strokeWidth="1.5" rx="5" />
        <text x="97" y="178" textAnchor="middle" fill="#7c3aed" fontSize="13" fontWeight="700">🗂️ 分拣台</text>
        <text x="97" y="196" textAnchor="middle" fill="#a78bfa" fontSize="10">按餐馆分装打包</text>
        {/* 工作台示意 */}
        <rect x="25" y="215" width="145" height="12" fill="#ddd6fe" rx="3" />
        <rect x="25" y="233" width="145" height="12" fill="#ddd6fe" rx="3" />
        <rect x="25" y="251" width="145" height="12" fill="#ddd6fe" rx="3" />

        {/* ── 冷藏区外框 ── */}
        <rect x="195" y="85" width="355" height="200" fill="#f0f9ff" stroke="#38bdf8" strokeWidth="2" rx="5" strokeDasharray="7 3" />
        <text x="372" y="102" textAnchor="middle" fill="#0284c7" fontSize="11" fontWeight="700" letterSpacing="1">❄️ 冷  藏  区</text>

        {/* 叶菜区 */}
        {(() => {
          const s = ZONE_STYLES['叶菜区']
          const active = hl('叶菜区')
          return (
            <g className={active ? 'wh-active' : ''}>
              <rect x="205" y="112" width="105" height="163" fill={active ? s.activeFill : s.fill} stroke={active ? s.activeStroke : s.stroke} strokeWidth={active ? 2 : 1.5} rx="4" />
              <text x="257" y="182" textAnchor="middle" fill={active ? s.activeText : s.textColor} fontSize="12" fontWeight="700">{s.label}</text>
              {active && <text x="257" y="200" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="600">● 当前作业区</text>}
            </g>
          )
        })()}

        {/* 根茎区 */}
        {(() => {
          const s = ZONE_STYLES['根茎区']
          const active = hl('根茎区')
          return (
            <g className={active ? 'wh-active' : ''}>
              <rect x="320" y="112" width="105" height="163" fill={active ? s.activeFill : s.fill} stroke={active ? s.activeStroke : s.stroke} strokeWidth={active ? 2 : 1.5} rx="4" />
              <text x="372" y="182" textAnchor="middle" fill={active ? s.activeText : s.textColor} fontSize="12" fontWeight="700">{s.label}</text>
              {active && <text x="372" y="200" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="600">● 当前作业区</text>}
            </g>
          )
        })()}

        {/* 菌菇区 */}
        {(() => {
          const s = ZONE_STYLES['菌菇区']
          const active = hl('菌菇区')
          return (
            <g className={active ? 'wh-active' : ''}>
              <rect x="435" y="112" width="105" height="163" fill={active ? s.activeFill : s.fill} stroke={active ? s.activeStroke : s.stroke} strokeWidth={active ? 2 : 1.5} rx="4" />
              <text x="487" y="182" textAnchor="middle" fill={active ? s.activeText : s.textColor} fontSize="12" fontWeight="700">{s.label}</text>
              {active && <text x="487" y="200" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="600">● 当前作业区</text>}
            </g>
          )
        })()}

        {/* ── 配送区（底部横条）── */}
        {(() => {
          const s = ZONE_STYLES['配送区']
          const active = hl('配送区')
          return (
            <g className={active ? 'wh-active' : ''}>
              <rect x="10" y="295" width="540" height="65" fill={active ? s.activeFill : s.fill} stroke={active ? s.activeStroke : s.stroke} strokeWidth={active ? 2 : 1.5} rx="5" />
              <text x="280" y="322" textAnchor="middle" fill={active ? s.activeText : s.textColor} fontSize="13" fontWeight="700">{s.label}</text>
              <text x="280" y="342" textAnchor="middle" fill={active ? '#fca5a5' : '#fca5a5'} fontSize="10">
                {active ? '● 当前作业区' : '装车出发 · 出货口'}
              </text>
            </g>
          )
        })()}

        {/* 出入口箭头 */}
        <text x="280" y="362" textAnchor="middle" fill="#94a3b8" fontSize="9">▼ 出货口</text>
      </svg>

      {/* 图例 */}
      {highlightZones.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs justify-center">
          {highlightZones.map(zone => {
            const s = ZONE_STYLES[zone]
            if (!s) return null
            return (
              <span key={zone} className="flex items-center gap-1 px-2 py-0.5 rounded-full font-medium border"
                style={{ backgroundColor: s.activeFill, color: '#ffffff', borderColor: s.activeStroke }}>
                <span className="w-1.5 h-1.5 rounded-full bg-white/70 animate-pulse inline-block" />
                {zone} 拣货中
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
