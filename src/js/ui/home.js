/* Encipherer · ui/home — 首页:新建工作区 / 打开工作区(.ecw 或本机副本)
 * 依赖:Encipherer.util / crypto / workspace;app(导航/主题)。
 * UMD:浏览器挂 Encipherer.ui.home;Node 分支导出空对象。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = {}; return; }
  root.Encipherer = root.Encipherer || {};
  root.Encipherer.ui = root.Encipherer.ui || {};
  root.Encipherer.ui.home = factory(root.Encipherer);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var util = E.util;
  var crypto = E.crypto;
  var workspace = E.workspace;

  var st = {
    root: null,
    pwInputs: [],
    fileInput: null,
    busy: false
  };

  /* ================= 小组件:密码强度 =================
   * 评分:长度(≥8 / ≥12)+ 字符类别(小写/大写/数字/符号,≥2 / ≥3)。
   * 返回 0-3:0-1 弱、2 中、3 强。 */
  function pwScore(pw) {
    if (!pw) return 0;
    var s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    var cls = 0;
    if (/[a-z]/.test(pw)) cls++;
    if (/[A-Z]/.test(pw)) cls++;
    if (/\d/.test(pw)) cls++;
    if (/[^A-Za-z0-9]/.test(pw)) cls++;
    if (cls >= 2) s++;
    if (cls >= 3) s++;
    if (pw.length < 8) s = Math.min(s, 1);
    if (pw.length < 6) s = 0;
    return s > 3 ? 3 : s;
  }
  var PW_LABELS = ['', '弱', '弱', '中'];
  function strengthLabel(sc) { return sc >= 3 ? '强' : PW_LABELS[sc] || '弱'; }

  function makeStrengthRow() {
    var fill = util.el('i');
    var bar = util.el('div', { class: 'progress' }, [fill]);
    var label = util.el('span', { class: 'ec-strength-label', text: '' });
    var wrap = util.el('div', { class: 'ec-strength' }, [bar, label]);
    return {
      el: wrap,
      update: function (pw) {
        var sc = pwScore(pw);
        wrap.className = 'ec-strength' + (pw ? ' s' + sc : '');
        fill.style.width = pw ? '' : '0';
        label.textContent = pw ? strengthLabel(sc) : '';
      }
    };
  }

  /* ================= 小组件:密码输入弹窗 =================
   * promptPassword(title, hint) -> Promise<string|null>(null=取消) */
  function promptPassword(title, hint) {
    return new Promise(function (resolve) {
      var input = util.el('input', { class: 'input ec-lock-input', type: 'password', autocomplete: 'off' });
      var msg = util.el('div', { class: 'ec-form-err', text: '' });
      var cancel = util.el('button', { class: 'btn', type: 'button', text: '取消' });
      var ok = util.el('button', { class: 'btn btn-primary', type: 'button', text: '确定' });
      var box = util.el('div', { class: 'ec-modal' }, [
        util.el('h3', { text: title || '输入密码' }),
        hint ? util.el('div', { class: 'ec-modal-body', text: hint }) : null,
        util.el('div', { class: 'ec-form-row' }, [input]),
        msg,
        util.el('div', { class: 'ec-modal-btns' }, [cancel, ok])
      ]);
      var overlay = util.el('div', { class: 'ec-modal-overlay' }, [box]);
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('show'); input.focus(); });
      function close(v) {
        overlay.classList.remove('show');
        setTimeout(function () { overlay.remove(); }, 200);
        resolve(v);
      }
      function submit() {
        var v = input.value;
        if (!v) {
          msg.textContent = '请输入密码';
          input.classList.remove('ec-shake'); void input.offsetWidth; input.classList.add('ec-shake');
          input.focus();
          return;
        }
        close(v);
      }
      cancel.addEventListener('click', function () { close(null); });
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(null); }
      });
    });
  }

  /* ================= 打开工作区流程 ================= */
  function afterOpen() {
    var ws = workspace.current;
    // 工作区显式指定了浅色/深色时才采用,避免覆盖用户本机选择
    if (ws && (ws.settings.theme === 'dark' || ws.settings.theme === 'light')) {
      util.bus.emit('theme:change', { mode: ws.settings.theme });
    }
    util.toast('工作区「' + workspace.current.name + '」已打开', 'ok');
    E.ui.app.navigate('workbench');
  }

  async function openEcwFile(file) {
    if (st.busy) return;
    var pw = await promptPassword('打开工作区', '输入工作区「' + (file && file.name ? file.name : '') + '」的主密码');
    if (pw === null) return;
    st.busy = true;
    util.toast('正在解密工作区…', 'info');
    await util.nextFrame();
    try {
      var ws = await workspace.openFromBlob(file, pw); // File 即 Blob
      if (!ws) { util.toast('密码错误', 'err'); return; }
      afterOpen();
    } catch (e) {
      util.toast('打开失败:' + (e && e.message || e), 'err');
    } finally {
      st.busy = false;
    }
  }

  async function openRecent(item) {
    if (st.busy) return;
    if (!item.hasLocal) {
      util.toast('该工作区本机没有副本,请点击「打开 .ecw 文件」选择导出的文件', 'warn');
      return;
    }
    var pw = await promptPassword('打开工作区', '输入工作区「' + item.name + '」的主密码');
    if (pw === null) return;
    st.busy = true;
    util.toast('正在读取本机副本并解密…', 'info');
    await util.nextFrame();
    try {
      var ws = await workspace.openFromLocal(item.id, pw);
      if (!ws) { util.toast('密码错误', 'err'); return; }
      afterOpen();
    } catch (e) {
      util.toast('打开失败:' + (e && e.message || e), 'err');
    } finally {
      st.busy = false;
    }
  }

  /* ================= 新建工作区 ================= */
  async function submitCreate(f) {
    if (st.busy) return;
    var name = f.nameInput.value.trim();
    var pw = f.pwInput.value;
    var pw2 = f.pw2Input.value;
    var iter = parseInt(f.iterInput.value, 10);
    if (!name) { util.toast('请输入工作区名称', 'warn'); f.nameInput.focus(); return; }
    if (name.length > 40) { util.toast('名称不能超过 40 个字', 'warn'); return; }
    if (pw.length < 8) { util.toast('密码至少 8 个字符', 'warn'); f.pwInput.focus(); return; }
    if (pw !== pw2) { util.toast('两次输入的密码不一致', 'warn'); f.pw2Input.focus(); return; }
    if (!isFinite(iter) || iter < 100000) { util.toast('PBKDF2 迭代次数须 ≥ 100000', 'warn'); return; }
    if (pwScore(pw) < 2) {
      var go = await util.confirmDialog({
        title: '密码强度偏弱',
        body: '当前密码强度为「' + strengthLabel(pwScore(pw)) + '」。密码用于派生加密密钥,建议混合大小写、数字与符号。仍要使用该密码吗?',
        confirmText: '仍要使用'
      });
      if (!go) return;
    }

    st.busy = true;
    f.submitBtn.classList.add('is-loading');
    await util.nextFrame(); // 先渲染 loading 再做重活(600k 次 PBKDF2)
    try {
      var ws = await workspace.create(name, pw);
      // 高级选项:自定义 PBKDF2 迭代次数(workspace.create 固定 DEFAULT_ITER,
      // 这里按 changePassword 同款逻辑重新派生并重新封装,再落盘)
      if (iter !== crypto.DEFAULT_ITER) {
        try {
          var salt = await crypto.randomSaltB64();
          var keys = await crypto.deriveKeys(pw, salt, iter);
          ws.saltB64 = salt; ws.iter = iter; ws._keys = keys;
          ws.verifier = await crypto.hmacHex(keys.kCheck, crypto.VERIFIER_MSG);
          await ws.saveLocal();
        } catch (e) {
          util.toast('自定义迭代次数应用失败,已使用默认值', 'warn');
        }
      }
      if (ws.settings.theme === 'dark' || ws.settings.theme === 'light') {
        util.bus.emit('theme:change', { mode: ws.settings.theme });
      }
      util.toast('工作区已创建,本机已保存加密副本', 'ok');
      E.ui.app.navigate('workbench');
    } catch (e) {
      util.toast('创建失败:' + (e && e.message || e), 'err');
    } finally {
      st.busy = false;
      f.submitBtn.classList.remove('is-loading');
    }
  }

  /* ================= 渲染 ================= */
  function renderRecents(listEl) {
    listEl.textContent = '';
    var recs = workspace.recents();
    if (!recs.length) {
      listEl.appendChild(util.el('div', { class: 'ec-empty' }, [
        util.el('div', { class: 'ec-empty-ico', text: '🗂' }),
        util.el('div', { text: '还没有最近的工作区' }),
        util.el('div', { class: 'ec-empty-hint', text: '在左侧新建一个,或打开导出的 .ecw 文件' })
      ]));
      return;
    }
    recs.forEach(function (r) {
      var item = util.el('div', { class: 'ec-recent-item', title: r.hasLocal ? '点击输入密码打开' : '本机无副本,需选择 .ecw 文件' });
      item.appendChild(util.el('div', { class: 'ec-recent-main' }, [
        util.el('div', { class: 'ec-recent-name', text: r.name }),
        util.el('div', { class: 'ec-recent-time', text: util.fmtTime(r.updatedAt) })
      ]));
      item.appendChild(util.el('span', {
        class: 'badge ' + (r.hasLocal ? 'badge-primary' : ''),
        text: r.hasLocal ? '本机有副本' : '仅文件'
      }));
      item.addEventListener('click', function () { openRecent(r); });
      listEl.appendChild(item);
    });
  }

  function mount(container) {
    st.root = util.el('div', { class: 'ec-scroll' });
    var page = util.el('div', { class: 'ec-home' });

    /* ---- 英雄区 ---- */
    var promises = [
      ['📴', '完全离线 · 零网络请求', '所有处理都在本页完成,不加载任何外部资源,可断网使用。'],
      ['🔐', 'AES-GCM 加密 · PBKDF2 60 万次派生', '映射表以军用级对称加密落盘,主密码派生密钥,无法暴力破解。'],
      ['💾', '数据不出本机,密钥只在内存', '明文只存在于内存与你显式导出的文件中,关闭即清除。']
    ].map(function (p) {
      return util.el('div', { class: 'card ec-promise' }, [
        util.el('div', { class: 'ec-promise-ico', text: p[0] }),
        util.el('div', null, [
          util.el('b', { text: p[1] }),
          util.el('span', { text: p[2] })
        ])
      ]);
    });
    page.appendChild(util.el('section', { class: 'ec-hero' }, [
      util.el('span', { class: 'ec-hero-eyebrow', text: '🔒 隐私优先 · 单文件 · 双击即用' }),
      util.el('h1', { text: '把含隐私的表格,安全地交出去' }),
      util.el('p', { class: 'ec-hero-sub', text: '把含隐私的表格安全地交给第三方或 AI——脱敏发出,处理后一键还原。' }),
      util.el('div', { class: 'ec-promises' }, promises)
    ]));

    /* ---- 新建 + 打开 ---- */
    var f = {};
    f.nameInput = util.el('input', { class: 'input', type: 'text', maxlength: '40', placeholder: '例如:客户数据外发-2026' });

    f.pwInput = util.el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '至少 8 个字符' });
    f.pw2Input = util.el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '再输入一次' });
    var pwStrength = makeStrengthRow();
    f.pwInput.addEventListener('input', function () { pwStrength.update(f.pwInput.value); });

    function bindEye(input) {
      var eye = util.el('button', { class: 'ec-eye', type: 'button', title: '显示/隐藏密码', text: '👁' });
      eye.addEventListener('click', function () {
        input.type = input.type === 'password' ? 'text' : 'password';
        eye.textContent = input.type === 'password' ? '👁' : '🙈';
      });
      return util.el('div', { class: 'ec-pw-wrap' }, [input, eye]);
    }

    f.iterInput = util.el('input', { class: 'input', type: 'number', min: '100000', step: '10000', value: String(crypto.DEFAULT_ITER) });
    var advOpen = false;
    var advBox = util.el('div', { class: 'ec-adv', style: { display: 'none' } }, [
      util.el('div', { class: 'ec-form-row', style: { margin: '0' } }, [
        util.el('label', { text: 'PBKDF2 迭代次数(≥100000,越大越慢越安全)' }), f.iterInput
      ]),
      util.el('div', { class: 'ec-adv-note', text: '默认 600000 次(OWASP 2023 建议)。此参数在创建时固定,之后不可修改。' })
    ]);
    var advToggle = util.el('button', { class: 'ec-adv-toggle', type: 'button', text: '高级选项 ▾' });
    advToggle.addEventListener('click', function () {
      advOpen = !advOpen;
      advBox.style.display = advOpen ? '' : 'none';
      advToggle.textContent = advOpen ? '高级选项 ▴' : '高级选项 ▾';
    });

    f.submitBtn = util.el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', text: '创建工作区' });
    var form = util.el('form', null, [
      util.el('div', { class: 'ec-form-row' }, [util.el('label', { text: '工作区名称' }), f.nameInput]),
      util.el('div', { class: 'ec-form-row' }, [util.el('label', { text: '主密码' }), bindEye(f.pwInput), pwStrength.el]),
      util.el('div', { class: 'ec-form-row' }, [util.el('label', { text: '确认密码' }), bindEye(f.pw2Input)]),
      advToggle, advBox,
      util.el('div', { style: { 'margin-top': '14px' } }, [f.submitBtn])
    ]);
    form.addEventListener('submit', function (e) { e.preventDefault(); submitCreate(f); });

    /* ---- 打开工作区 ---- */
    var recentList = util.el('div', { class: 'ec-recent-list' });
    st.fileInput = util.el('input', { type: 'file', accept: '.ecw', style: { display: 'none' } });
    st.fileInput.addEventListener('change', function () {
      var fs = st.fileInput.files;
      if (fs && fs.length) openEcwFile(fs[0]);
      st.fileInput.value = '';
    });
    var openBtn = util.el('button', { class: 'btn btn-block', type: 'button', text: '📄 打开 .ecw 文件' });
    openBtn.addEventListener('click', function () { st.fileInput.click(); });
    var dropHint = util.el('div', { class: 'ec-drop-hint', text: '也可以把 .ecw 文件拖到窗口任意位置' });

    var grid = util.el('div', { class: 'ec-home-grid' }, [
      util.el('section', { class: 'card' }, [
        util.el('h3', { text: '🆕 新建工作区' }),
        util.el('div', { class: 'card-sub', text: '工作区 = 一次「脱敏-还原」任务。同类型同原值永远得到同一占位符,跨文件、跨次运行稳定。' }),
        form
      ]),
      util.el('section', { class: 'card' }, [
        util.el('h3', { text: '📂 打开工作区' }),
        util.el('div', { class: 'card-sub', text: '最近使用(仅本机可见):' }),
        recentList,
        util.el('div', { style: { 'margin-top': '12px', display: 'flex', 'flex-direction': 'column', gap: '8px' } }, [
          openBtn, dropHint, st.fileInput
        ])
      ])
    ]);
    page.appendChild(grid);

    /* ---- 三步说明 ---- */
    var steps = [
      ['新建工作区并上传表格', '用主密码创建工作区,把 .xlsx / .xlsm / .xls / .csv 拖进来。'],
      ['框选敏感区域生成脱敏副本', '自动扫描或手动框选手机号、身份证等列,一键生成格式不变的假数据副本。'],
      ['处理完后回传,智能还原', '第三方处理完的表格拖回「还原」页,逐格识别占位符,一键换回真实数据。']
    ].map(function (s, i) {
      return util.el('div', { class: 'card ec-step' }, [
        util.el('div', { class: 'ec-step-no', text: String(i + 1) }),
        util.el('div', null, [util.el('b', { text: s[0] }), util.el('span', { text: s[1] })])
      ]);
    });
    page.appendChild(util.el('section', { class: 'ec-steps' }, [
      util.el('h3', { text: '三步上手', style: { 'margin-bottom': '12px' } }),
      util.el('div', { class: 'ec-steps-row' }, steps)
    ]));

    st.root.appendChild(page);
    container.appendChild(st.root);
    renderRecents(recentList);
  }

  function unmount() {
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    st.root = null; st.fileInput = null; st.busy = false;
  }

  /* 全局拖放回调(app.js 转发):首页只接受 .ecw */
  function handleFiles(files) {
    for (var i = 0; i < files.length; i++) {
      if (/\.ecw$/i.test(files[i].name)) { openEcwFile(files[i]); return; }
    }
    util.toast('首页仅支持打开 .ecw 工作区文件;表格请进入工作区后再上传', 'warn');
  }

  return { mount: mount, unmount: unmount, handleFiles: handleFiles };
});
