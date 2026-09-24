/* Encipherer · ui/settings — 设置(外观 / 占位符 / 安全 / 数据 / 危险区)
 * 读写 workspace.current.settings;变更后自动 saveLocal 并 toast。
 * UMD:浏览器挂 Encipherer.ui.settings;Node 分支导出空对象。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = {}; return; }
  root.Encipherer = root.Encipherer || {};
  root.Encipherer.ui = root.Encipherer.ui || {};
  root.Encipherer.ui.settings = factory(root.Encipherer);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var util = E.util;
  var workspace = E.workspace;

  var st = { root: null };

  function ws() { return workspace.current; }

  function persist(msg) {
    var w = ws();
    if (!w) return;
    w.saveLocal().then(
      function () { util.toast(msg || '设置已保存', 'ok'); },
      function (e) { util.toast('设置已生效,但本地保存失败:' + (e && e.message || e), 'warn'); }
    );
  }

  /* 密码强度(home 同款算法,此处独立实现避免跨屏依赖) */
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

  function radioLine(name, value, checked, label, desc) {
    var input = util.el('input', { type: 'radio', name: name, value: value });
    input.checked = !!checked;
    var line = util.el('label', { class: 'ec-radio-line' }, [input, util.el('span', { text: label })]);
    if (desc) line.appendChild(util.el('span', { class: 'ec-radio-desc', text: desc }));
    return { input: input, el: line };
  }

  async function exportWorkspaceFile(btn) {
    var w = ws();
    if (!w) return;
    btn.classList.add('is-loading');
    try {
      var blob = await w.exportFile();
      util.download(blob, w.suggestedFileName());
      util.toast('已导出加密工作区文件,请妥善保管:泄露该文件 + 泄露密码 = 泄露全部映射', 'warn');
    } catch (e) {
      util.toast('导出失败:' + (e && e.message || e), 'err');
    } finally {
      btn.classList.remove('is-loading');
    }
  }

  async function submitChangePassword(f) {
    var w = ws();
    if (!w) return;
    var oldPw = f.oldInput.value, newPw = f.newInput.value, newPw2 = f.new2Input.value;
    if (!oldPw) { util.toast('请输入原密码', 'warn'); return; }
    if (newPw.length < 8) { util.toast('新密码至少 8 个字符', 'warn'); return; }
    if (newPw !== newPw2) { util.toast('两次输入的新密码不一致', 'warn'); return; }
    f.btn.classList.add('is-loading');
    await util.nextFrame();
    try {
      var ok = await w.changePassword(oldPw, newPw);
      if (!ok) { util.toast('原密码错误', 'err'); return; }
      await w.saveLocal();
      f.oldInput.value = ''; f.newInput.value = ''; f.new2Input.value = '';
      f.strength.update('');
      util.toast('密码已修改,本机副本已用新密码重新加密', 'ok');
    } catch (e) {
      util.toast('修改失败:' + (e && e.message || e), 'err');
    } finally {
      f.btn.classList.remove('is-loading');
    }
  }

  async function destroyWorkspace(f) {
    var w = ws();
    if (!w) return;
    if (f.nameInput.value !== w.name) { util.toast('输入的工作区名称不一致', 'warn'); return; }
    var ok = await util.confirmDialog({
      title: '销毁工作区',
      body: '将删除本机加密副本与最近记录,且无法恢复。<br>如以后还要使用,请先导出 .ecw 文件。确定销毁「' + util.esc(w.name) + '」?',
      danger: true,
      confirmText: '永久销毁'
    });
    if (!ok) return;
    f.btn.classList.add('is-loading');
    try {
      // 先断开 current 再 destroy(destroy→lock 会发 locked 事件,避免误弹锁屏)
      workspace.current = null;
      await w.destroy();
      if (E.ui.lock && typeof E.ui.lock.unmount === 'function') E.ui.lock.unmount();
      util.toast('工作区已销毁', 'ok');
      E.ui.app.navigate('home');
    } catch (e) {
      workspace.current = w; // 失败回滚
      util.toast('销毁失败:' + (e && e.message || e), 'err');
    } finally {
      f.btn.classList.remove('is-loading');
    }
  }

  function mount(container) {
    var w = ws();
    if (!w || w.isLocked()) { E.ui.app.navigate('home'); return; }
    var S = w.settings;

    /* ---- 外观 ---- */
    var themeRadios = ['auto', 'light', 'dark'].map(function (v) {
      var labels = { auto: '跟随系统', light: '浅色', dark: '深色' };
      return radioLine('ec-set-theme', v, S.theme === v, labels[v], null);
    });
    themeRadios.forEach(function (r) {
      r.input.addEventListener('change', function () {
        if (!r.input.checked) return;
        S.theme = r.input.value;
        util.bus.emit('theme:change', { mode: S.theme }); // app 负责实际切换
        persist('主题已切换');
      });
    });

    /* ---- 占位符 ---- */
    var gs1 = radioLine('ec-set-gs', 'short', S.genericStyle !== 'prefix', '短码', '如 7K2M9'),
        gs2 = radioLine('ec-set-gs', 'prefix', S.genericStyle === 'prefix', '带前缀', '如 T-7K2M9,便于还原时识别');
    [gs1, gs2].forEach(function (r) {
      r.input.addEventListener('change', function () {
        if (!r.input.checked) return;
        S.genericStyle = r.input.value;
        persist('通用占位符样式已保存(只影响之后生成的新映射)');
      });
    });
    var keepDomain = util.el('input', { type: 'checkbox' });
    keepDomain.checked = S.keepEmailDomain !== false;
    keepDomain.addEventListener('change', function () {
      S.keepEmailDomain = keepDomain.checked;
      persist('邮箱域名设置已保存(只影响之后生成的新映射)');
    });

    /* ---- 安全 ---- */
    var lockSel = util.el('select', { class: 'select' });
    [[0, '不自动锁定'], [5, '5 分钟'], [10, '10 分钟'], [30, '30 分钟'], [60, '60 分钟']].forEach(function (o) {
      var opt = util.el('option', { value: String(o[0]), text: o[1] });
      if ((S.autoLockMin || 0) === o[0]) opt.selected = true;
      lockSel.appendChild(opt);
    });
    lockSel.addEventListener('change', function () {
      S.autoLockMin = parseInt(lockSel.value, 10) || 0;
      persist(S.autoLockMin ? '无操作 ' + S.autoLockMin + ' 分钟后自动锁定' : '已关闭自动锁定');
    });

    var f = {};
    f.oldInput = util.el('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '原密码' });
    f.newInput = util.el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '新密码(≥8 字符)' });
    f.new2Input = util.el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '确认新密码' });
    f.strength = {
      update: function (pw) {
        var sc = pwScore(pw);
        f.strengthWrap.className = 'ec-strength' + (pw ? ' s' + sc : '');
        f.strengthFill.style.width = pw ? '' : '0';
        f.strengthLabel.textContent = pw ? (sc >= 3 ? '强' : (sc === 2 ? '中' : '弱')) : '';
      }
    };
    f.strengthFill = util.el('i');
    f.strengthLabel = util.el('span', { class: 'ec-strength-label', text: '' });
    f.strengthWrap = util.el('div', { class: 'ec-strength' }, [
      util.el('div', { class: 'progress' }, [f.strengthFill]), f.strengthLabel
    ]);
    f.newInput.addEventListener('input', function () { f.strength.update(f.newInput.value); });
    f.btn = util.el('button', { class: 'btn btn-primary', type: 'button', text: '修改密码' });
    f.btn.addEventListener('click', function () { submitChangePassword(f); });

    /* ---- 数据 ---- */
    var exportBtn = util.el('button', { class: 'btn', type: 'button', text: '📤 导出工作区文件(.ecw)' });
    exportBtn.addEventListener('click', function () { exportWorkspaceFile(exportBtn); });
    var forgetBtn = util.el('button', { class: 'btn btn-danger btn-outline', type: 'button', text: '🧹 清除本机副本' });
    forgetBtn.addEventListener('click', async function () {
      var ok = await util.confirmDialog({
        title: '清除本机副本',
        body: '将删除本机保存的加密副本与最近记录。清除后下次只能用导出的 .ecw 文件 + 密码打开,确定?',
        danger: true,
        confirmText: '清除副本'
      });
      if (!ok) return;
      try {
        await w.forgetLocal();
        util.toast('本机副本已清除;请妥善保管 .ecw 文件', 'ok');
      } catch (e) {
        util.toast('清除失败:' + (e && e.message || e), 'err');
      }
    });

    /* ---- 危险区 ---- */
    var df = {};
    df.nameInput = util.el('input', { class: 'input', type: 'text', placeholder: '输入工作区名称「' + w.name + '」以确认' });
    df.btn = util.el('button', { class: 'btn btn-danger', type: 'button', text: '永久销毁工作区', disabled: 'disabled' });
    df.nameInput.addEventListener('input', function () {
      df.btn.disabled = df.nameInput.value !== w.name;
    });
    df.btn.addEventListener('click', function () { destroyWorkspace(df); });

    /* ---- 组装 ---- */
    st.root = util.el('div', { class: 'ec-scroll' });
    var page = util.el('div', { class: 'ec-page' });
    page.appendChild(util.el('h2', { text: '设置', style: { 'margin-bottom': '14px' } }));

    var left = util.el('div', null);
    left.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: '🎨 外观' }),
      themeRadios.map(function (r) { return r.el; })
    ]));
    left.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: '🧬 占位符' }),
      util.el('div', { class: 'card-sub', text: '仅对之后新生成的映射生效;已有映射保持不变。' }),
      gs1.el, gs2.el,
      util.el('label', { class: 'ec-check-line', style: { 'margin-top': '6px' } }, [
        keepDomain, util.el('span', { text: '生成假邮箱时保留原域名(@后不变)' })
      ])
    ]));
    left.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: '🔐 安全' }),
      util.el('div', { class: 'ec-setting-row' }, [
        util.el('div', { class: 'ec-setting-label' }, [
          util.el('b', { text: '自动锁定' }),
          util.el('span', { text: '无操作一段时间后自动清除内存密钥' })
        ]), lockSel
      ]),
      util.el('div', { class: 'ec-setting-row' }, [
        util.el('div', { class: 'ec-setting-label' }, [
          util.el('b', { text: 'PBKDF2 迭代次数' }),
          util.el('span', { text: '创建时固定,不可更改' })
        ]),
        util.el('span', { class: 'badge badge-primary', text: w.iter.toLocaleString() + ' 次' })
      ]),
      util.el('div', { style: { 'margin-top': '12px' } }, [
        util.el('div', { class: 'ec-form-row' }, [util.el('label', { text: '修改主密码' })]),
        util.el('div', { class: 'ec-form-row' }, [f.oldInput]),
        util.el('div', { class: 'ec-form-row' }, [f.newInput, f.strengthWrap]),
        util.el('div', { class: 'ec-form-row' }, [f.new2Input]),
        f.btn
      ])
    ]));

    var right = util.el('div', null);
    right.appendChild(util.el('section', { class: 'card' }, [
      util.el('h3', { text: '💾 数据' }),
      util.el('div', { class: 'card-sub', text: '当前工作区:' + w.name + ' · 创建于 ' + util.fmtTime(w.createdAt) }),
      util.el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } }, [exportBtn, forgetBtn])
    ]));
    right.appendChild(util.el('section', { class: 'card card-danger' }, [
      util.el('h3', { text: '☠ 危险区' }),
      util.el('div', { class: 'card-sub', text: '销毁将删除本机副本与最近记录,无法恢复。' }),
      util.el('div', { class: 'ec-form-row' }, [df.nameInput]),
      df.btn
    ]));

    page.appendChild(util.el('div', { class: 'ec-setting-grid' }, [left, right]));
    st.root.appendChild(page);
    container.appendChild(st.root);
  }

  function unmount() {
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    st.root = null;
  }

  return { mount: mount, unmount: unmount };
});
