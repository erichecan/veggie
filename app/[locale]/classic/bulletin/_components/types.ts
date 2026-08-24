import type { BulletinCategoryValue } from '@/lib/bulletin-categories'

export interface BulletinPost {
  id: string
  category: BulletinCategoryValue
  source: 'MANUAL' | 'AUTO'
  content: string
  imageUrl: string | null
  createdAt: string
  pinned: boolean
  pinnedAt: string | null
  author: { id: string; name: string; role: string } | null
  pinnedBy: { id: string; name: string } | null
}
