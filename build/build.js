#!/usr/bin/env node
/* Encipherer 构建脚本:把 src/ + vendor/ 内联成单文件 dist/Encipherer.html
 * 用法:node build/build.js [--dev](--dev 附加 sourcemap 注释便于排查,产物不变更结构) */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'Encipherer.html');

const CSS_FILES = [
  'src/css/app.css',
  'src/css/grid.css'
];
const JS_FILES = [
  'vendor/xlsx.full.min.js',
  'vendor/exceljs.min.js',
  'src/js/util.js',
  'src/js/crypto.js',
  'src/js/fakery.js',
  'src/js/excel.js',
  'src/js/workspace.js',
  'src/js/ui/grid.js',
  'src/js/ui/app.js',
  'src/js/ui/home.js',
  'src/js/ui/workbench.js',
  'src/js/ui/restore.js',
  'src/js/ui/mapping.js',
  'src/js/ui/settings.js',
  'src/js/ui/lock.js',
  'src/js/ui/help.js'
];

function read(p) {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) {
    console.warn('  [跳过] 缺少文件: ' + p);
    return null;
  }
  return fs.readFileSync(abs, 'utf8');
}

// 内联 <script> 的安全转义:仅字符串语境中可能出现,替换后运行时语义不变
function safeInlineJs(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function build() {
  const missing = JS_FILES.concat(CSS_FILES).filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.warn('警告:以下文件尚未就绪,将跳过:');
    missing.forEach(m => console.warn('  - ' + m));
  }

  const css = CSS_FILES.map(f => {
    const c = read(f);
    return c ? `/* ===== ${f} ===== */\n${c}` : `/* ===== ${f}(缺失) ===== */`;
  }).join('\n\n');

  const js = JS_FILES.map(f => {
    const c = read(f);
    return c ? `/* ===== ${f} ===== */\n${safeInlineJs(c)}` : `/* ===== ${f}(缺失) ===== */`;
  }).join('\n\n');

  const version = require(path.join(ROOT, 'package.json')).version;
  const buildTime = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  let html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  // 注意:必须用函数形式 replace,避免内联代码中的 $&/$' 等特殊替换串破坏输出
  html = html
    .replace('/* @CSS@ */', function () { return css; })
    .replace('/* @JS@ */', function () { return js; })
    .replace('__VERSION__', function () { return version; })
    .replace('__BUILD_TIME__', function () { return buildTime; });

  if (html.includes('/* @CSS@ */') || html.includes('/* @JS@ */')) {
    console.warn('警告:模板标记未完全替换(检查 src/index.html)');
  }

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  const size = fs.statSync(OUT).size;
  console.log(`✔ 构建完成: dist/Encipherer.html  (${(size / 1048576).toFixed(2)} MB, v${version}, ${buildTime})`);
}

build();
