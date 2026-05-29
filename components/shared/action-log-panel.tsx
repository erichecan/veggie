'use client'
import ChatterFeed from './chatter-feed'

/**
 * ActionLogPanel —— 现已改为 ChatterFeed 的薄封装。
 *
 * 历史背景：
 *   1.x 时代这是一个独立的紧凑单行日志面板（"04/17 03:33  修改  Operator  更新客户: ..."）。
 *   客户反馈"操作记录还是需要有：谁 + 做了什么（具体到改了什么）+ 时间"，
 *   于是新增了 components/shared/chatter-feed.tsx 实现 Odoo Chatter 风格。
 *
 * 为了让所有现有调用方（10+ 个 page）零改动地获得新格式，
 * 这里把 ActionLogPanel 改成 ChatterFeed 的转发器。
 *
 * 调用方仍可继续使用 <ActionLogPanel resource="..." resourceId="..." />，
 * 渲染效果与 <ChatterFeed ...> 完全一致。
 */

interface Props {
  resource?: string
  resourceId?: string
}

export default function ActionLogPanel({ resource, resourceId }: Props) {
  return (
    <div className="mt-8 border-t border-gray-100 pt-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-xs text-gray-400 font-medium">操作记录</p>
      </div>
      <ChatterFeed
        resource={resource ?? ''}
        resourceId={resourceId}
      />
    </div>
  )
}
