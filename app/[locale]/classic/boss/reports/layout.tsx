/**
 * 报表分析三张表（sales / purchasing / logistics）的公共外壳。
 *
 * 历史：这三个页面此前**没有任何导航入口** —— 代码、接口、SQL 视图、权限全都在，
 * 但整个系统里没有一个链接指向它们。功能到不了 = 等于不存在。
 * 于是 20260807 给它们加了一条 tab。
 *
 * 20260920：客户要求数据中心只留「销售分析」「采购分析」两项，
 * sales / logistics 两张报表从导航撤下，这条 tab 因此只剩一个标签 —— 一个标签的
 * tab 条是纯噪音，而且它顶在采购分析页上方，破坏了与「销售分析」页的视觉一致
 * （那页没有 tab 条）。整条移除，外壳退化成透传。
 * 两个页面本身与接口都还在，直链 `/classic/boss/reports/sales`、
 * `/classic/boss/reports/logistics` 仍可访问；要把入口加回来，改
 * `app/[locale]/classic/boss/layout.tsx` 的 LINKS 数组即可。
 */
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
