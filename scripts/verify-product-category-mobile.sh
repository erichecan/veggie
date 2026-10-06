#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
node --test --import=tsx tests/product-category-tree.test.ts tests/product-category-navigation.test.ts tests/pricing-engine-formula.test.ts
npx eslint lib/product-category-tree.ts lib/product-category-navigation.ts lib/product-category-write.ts components/classic/OrderMobileList.tsx components/classic/ProductCategoryManager.tsx tests/product-category-tree.test.ts tests/product-category-navigation.test.ts scripts/audit/verify-category-mobile.ts
git diff --check

if [[ "${CATEGORY_MOBILE_BROWSER_CHECK:-0}" == "1" ]]; then
  npx tsx scripts/audit/verify-category-mobile.ts
fi

if [[ "${CATEGORY_MOBILE_RBAC_CHECK:-0}" == "1" ]]; then
  node --test --import=tsx tests/rbac-gate.test.ts tests/rbac-route-map.test.ts
fi
