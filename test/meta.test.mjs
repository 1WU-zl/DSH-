/**
 * 元信息解析全面验证：逐一验证"支持哪些写法"这一声明，不留未验证的承诺。
 * 用例格式：[说明, 脚本文本, 回退文件名, 期望名称, 期望说明]
 */
import { parseMeta } from '../lib/index.js'

const cases = [
  ['# 前缀 (.ps1/.py)', '# @script 数据库备份\n# @desc 备份 practice 库', 'a.ps1', '数据库备份', '备份 practice 库'],
  ['// 前缀 (.js/.mjs)', '// @script 前端构建\n// @desc 打包并压缩前端资源', 'a.mjs', '前端构建', '打包并压缩前端资源'],
  ['-- 前缀 (.sql)', '-- @script 每日统计\n-- @desc 统计每日流水合计', 'a.sql', '每日统计', '统计每日流水合计'],
  ['REM 前缀 (.bat)', 'REM @script 清理临时文件\nREM @desc 删除 7 天前的临时文件', 'a.bat', '清理临时文件', '删除 7 天前的临时文件'],
  [':: 前缀 (.bat)', ':: @script 启动服务\n:: @desc 启动本地服务并打印端口', 'b.bat', '启动服务', '启动本地服务并打印端口'],
  ['<!-- 前缀 (.html)', '<!-- @script 生成报表\n     @desc 输出 HTML 报表 -->', 'a.html', '生成报表', '输出 HTML 报表'],
  ['/* 前缀（块注释起始）', '/* @script 打包发布\n * @desc 打成 zip 并上传 */', 'a.c', '打包发布', '打成 zip 并上传'],
  ['* 前缀（块注释续行）', '/*\n * @script 块内名称\n * @desc 块内说明 */', 'b.c', '块内名称', '块内说明'],
  ['带冒号', '// @script: 端口检查\n// @desc: 查看端口占用', 'a.mjs', '端口检查', '查看端口占用'],
  ['中文全角冒号', '# @script：全角冒号\n# @desc：全角说明', 'a.ps1', '全角冒号', '全角说明'],
  ['@name / @description 别名', '// @name 别名名称\n// @description 别名说明文字', 'a.mjs', '别名名称', '别名说明文字'],
  ['大小写不敏感', '# @SCRIPT 大写名称\n# @DESC 大写说明', 'a.ps1', '大写名称', '大写说明'],
  ['注释符与 @ 之间无空格', '#@script 紧凑写法\n#@desc 紧凑说明', 'a.ps1', '紧凑写法', '紧凑说明'],
  ['元信息在第 10 行（限内）', '\n'.repeat(9) + '# @script 靠后但不超限\n# @desc 说明也在后面', 'a.ps1', '靠后但不超限', '说明也在后面'],
  ['第 500 行 → 应被忽略并回退', 'x\n'.repeat(500) + '# @script 太远了', 'far.py', 'far.py', ''],
  ['完全没有元信息 → 回退文件名', 'print("hello")', 'plain.py', 'plain.py', ''],
  ['只有 @script', '# @script 只有名称', 'a.ps1', '只有名称', ''],
  ['只有 @desc', '# @desc 只有说明', 'only.py', 'only.py', '只有说明'],
  ['普通注释不会误判为元信息', '# 这是一行普通注释\n# 也不是元信息\nprint(1)', 'c.py', 'c.py', ''],
  ['值里含冒号', '# @desc 用法: 直接双击运行', 'a.ps1', 'a.ps1', '用法: 直接双击运行'],
  ['@ 开头的普通注释不匹配', '# @author 张三\n# @date 2026-10-14', 'd.ps1', 'd.ps1', ''],
]

let pass = 0
const fails = []

for (const [label, text, fallback, wantName, wantDesc] of cases) {
  const got = parseMeta(text, fallback)
  if (got.name === wantName && got.desc === wantDesc) pass++
  else fails.push(`FAIL ${label}\n      期望 name="${wantName}" desc="${wantDesc}"\n      实际 name="${got.name}" desc="${got.desc}"`)
}

console.log('===== 元信息解析全面验证 =====')
for (const f of fails) console.log(' ', f)
console.log(`\n通过 ${pass} / ${cases.length}`)
if (fails.length) process.exitCode = 1
