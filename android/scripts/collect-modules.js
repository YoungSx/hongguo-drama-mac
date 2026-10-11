'use strict';
/**
 * 按依赖闭包把运行时用到的包复制进打包目录（不装 npm，不复制嵌套 node_modules）。
 * 用法: node collect-modules.js <项目根> <目标 node_modules> <包名...>
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const out = process.argv[3];
const entries = process.argv.slice(4);
const seen = new Set();

// 不能用 require.resolve(`${name}/package.json`)：部分包（如 proxy-from-env）的 exports 不暴露 package.json。
function packageDir(name) {
  for (const base of require.resolve.paths(name) || []) {
    const candidate = path.join(base, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`找不到依赖 ${name}`);
}

function walk(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const dir = packageDir(name);
  fs.cpSync(dir, path.join(out, name), {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes('node_modules'),
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) walk(dep);
}

fs.mkdirSync(out, { recursive: true });
for (const name of entries) walk(name);
console.log(`[collect-modules] ${seen.size} 个包 -> ${out}`);
