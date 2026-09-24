/* Encipherer · ui/help — 帮助 / 关于(静态内容)
 * 版本信息取自 window.__EC_BUILD__(构建时注入)。
 * UMD:浏览器挂 Encipherer.ui.help;Node 分支导出空对象。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = {}; return; }
  root.Encipherer = root.Encipherer || {};
  root.Encipherer.ui = root.Encipherer.ui || {};
  root.Encipherer.ui.help = factory(root.Encipherer);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var util = E.util;

  var st = { root: null };

  function kbd(s) { return util.el('kbd', { class: 'ec-kbd', text: s }); }

  function shortcutRow(keys, desc) {
    var td1 = util.el('td');
    keys.forEach(function (k, i) {
      if (i) td1.appendChild(document.createTextNode(' + '));
      td1.appendChild(kbd(k));
    });
    return util.el('tr', null, [td1, util.el('td', { text: desc })]);
  }

  function mount(container) {
    var build = (typeof window !== 'undefined' && window.__EC_BUILD__) || {};
    var version = build.version || '1.0.0';
    var time = build.time || '';

    var steps = [
      ['1. 新建工作区', '首页用「名称 + 主密码」创建工作区。同一工作区内,同一原值永远映射到同一占位符——发给对方的两个文件里,同一个人还是同一个人(假身份)。'],
      ['2. 上传并框选', '在工作台上传表格,点击「自动扫描」找敏感列,或在表格里拖选区域后「对选中区域应用」;可先用「预览效果」查看替换结果(不写入映射)。'],
      ['3. 执行脱敏并下载', '点击「执行脱敏」,生成格式保真的假数据副本(手机号还是手机号、身份证还能通过校验位),下载后即可外发。'],
      ['4. 回传还原', '第三方处理完的文件拖回「还原」页,智能扫描逐格识别占位符并换回真实值——对方增删行列也不影响。']
    ].map(function (s) {
      return util.el('div', { class: 'card' }, [
        util.el('h3', { text: s[0] }),
        util.el('p', { text: s[1], style: { margin: '0', color: 'var(--ec-muted)', 'font-size': '13px' } })
      ]);
    });

    var scenarios = [
      ['🤖 交给 AI 处理', '把含姓名、手机号的表脱敏后粘贴/上传给 AI,拿到结果再还原。'],
      ['📦 外包 / 第三方分析', '发给外部做数据分析、标注、清洗,回传文件一键还原。'],
      ['🧪 共享测试数据', '给开发/测试环境的「假但真实」数据:格式、长度、校验位全部保持,业务逻辑不报错。']
    ].map(function (s) {
      return util.el('li', null, [util.el('b', { text: s[0] + ':' }), ' ' + s[1]]);
    });

    var privacy = [
      '完全离线运行:零网络请求、零 CDN、零字体外链,可断网使用(CSP 已限死)。',
      '加密参数:PBKDF2-HMAC-SHA256 600,000 次迭代派生主密钥,HKDF 再派生三把子钥;映射以 AES-GCM-256 加密。',
      '数据留存:加密副本只存本机(IndexedDB / localStorage);明文只存在于内存与你显式导出的文件。',
      '建议操作:长时间不用请用「锁定」;外发 .ecw 文件时务必保管好密码——文件+密码=全部映射。'
    ].map(function (s) { return util.el('li', { text: s }); });

    var limits = [
      '.xls / .xlsm 写回时样式与宏可能降级(处理时会提示「将降级」);建议优先转存 .xlsx。',
      '合并单元格只替换左上角格的值。',
      '公式格按其计算结果脱敏,公式本身会被替换为占位文本。',
      '表格预览最多显示前 1000 行(处理始终作用于全量数据)。',
      'CSV 读取自适应 UTF-8 / GBK 编码;导出统一带 BOM 的 UTF-8。'
    ].map(function (s) { return util.el('li', { text: s }); });

    var shortcuts = util.el('table', { class: 'table' }, [
      util.el('thead', null, [util.el('tr', null, [
        util.el('th', { text: '快捷键' }), util.el('th', { text: '作用' })
      ])]),
      util.el('tbody', null, [
        shortcutRow(['Ctrl / ⌘', 'O'], '上传表格(工作台 / 还原页)'),
        shortcutRow(['Ctrl / ⌘', 'L'], '立即锁定工作区'),
        shortcutRow(['Ctrl / ⌘', 'A'], '在表格内全选当前窗口(由表格组件处理)'),
        shortcutRow(['Esc'], '关闭弹窗 / 清除表格选区'),
        shortcutRow(['方向键 / PgUp / PgDn'], '移动活动格'),
        shortcutRow(['Shift + 点击'], '扩展选区;Ctrl + 拖选可累积多块选区')
      ])
    ]);

    st.root = util.el('div', { class: 'ec-scroll' });
    var page = util.el('div', { class: 'ec-page' });
    page.appendChild(util.el('div', { class: 'ec-help-sec' }, [
      util.el('h2', { text: '快速上手', style: { 'margin-bottom': '12px' } }),
      util.el('div', { class: 'ec-help-steps' }, steps)
    ]));
    page.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: '🎯 典型场景' }),
      util.el('ul', null, scenarios)
    ]));
    page.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: '🛡 隐私与安全说明' }),
      util.el('ul', null, privacy)
    ]));
    page.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: '⌨ 快捷键' }),
      shortcuts
    ]));
    page.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: '⚠ 已知限制' }),
      util.el('ul', null, limits)
    ]));
    page.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: 'ℹ 关于' }),
      util.el('p', { text: 'Encipherer 表格隐私卫士 v' + version + (time ? '(构建于 ' + time + ')' : ''), style: { margin: 0 } }),
      util.el('p', {
        text: '单文件离线应用:本页内嵌全部代码与依赖,双击 HTML 即可运行,无需安装、无需联网。',
        style: { margin: '6px 0 0', color: 'var(--ec-muted)', 'font-size': '13px' }
      })
    ]));

    st.root.appendChild(page);
    container.appendChild(st.root);
  }

  function unmount() {
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    st.root = null;
  }

  return { mount: mount, unmount: unmount };
});
