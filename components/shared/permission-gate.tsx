'use client'
import { ReactNode } from 'react'
import { can, useAbility, type Action, type Subject } from '@/lib/permissions'

/**
 * 权限门组件。当前角色无权限时不渲染 children。
 *
 * 用法：
 *   <PermissionGate action="delete" subject="invoice">
 *     <DeleteButton />
 *   </PermissionGate>
 *
 *   <PermissionGate action="delete" subject="invoice" fallback={<DisabledBtn />}>
 *     <DeleteButton />
 *   </PermissionGate>
 */
export default function PermissionGate({
  action,
  subject,
  children,
  fallback = null,
}: {
  action: Action
  subject: Subject
  children: ReactNode
  fallback?: ReactNode
}) {
  const ability = useAbility()
  if (!can(ability, action, subject)) return <>{fallback}</>
  return <>{children}</>
}
