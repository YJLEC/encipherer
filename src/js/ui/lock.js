/* Encipherer · ui/lock — 锁屏遮罩(不可关闭,盖住主界面)
 * app.js 在 bus 'workspace:locked' 时调用 mount();'workspace:unlocked' 时 unmount()。
 * UMD:浏览器挂 Encipherer.ui.lock;Node 分支导出空对象。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = {}; return; }
  root.Encipherer = root.Encipherer || {};
  root.Encipherer.ui = root.Encipherer.ui || {};
  root.Encipherer.ui.lock = factory(root.Encipherer);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var util = E.util;
  var workspace = E.workspace;

  var LOCK_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 8 14v16c0 15 10 25 24 30 14-5 24-15 24-30V14L32 4z" fill="#1a7f5a"/><rect x="20" y="26" width="24" height="18" rx="3" fill="#fff"/><path d="M25 26v-4a7 7 0 0 1 14 0v4" fill="none" stroke="#fff" stroke-width="4"/><circle cx="32" cy="34" r="3" fill="#1a7f5a"/><path d="M32 37v3" stroke="#1a7f5a" stroke-width="2.5" stroke-linecap="round"/></svg>';

  var st = {
    el: null,
    input: null,
    msg: null,
    unlockBtn: null,
    busHandler: null,
    busy: false
  };

  function shake() {
    if (!st.input) return;
    st.input.classList.remove('ec-shake');
    void st.input.offsetWidth; // 重启动画
    st.input.classList.add('ec-shake');
  }

  async function doUnlock() {
    if (st.busy) return;
    var ws = workspace.current;
    if (!ws) { unmount(); return; }
    var pw = st.input.value;
    if (!pw) { st.msg.textContent = '请输入主密码'; shake(); st.input.focus(); return; }
    st.busy = true;
    st.unlockBtn.classList.add('is-loading');
    st.msg.textContent = '正在解密…';
    await util.nextFrame();
    try {
      var ok = await ws.unlock(pw);
      if (!ok) {
        st.msg.textContent = '密码错误,请重试';
        st.input.value = '';
        shake();
        st.input.focus();
        return;
      }
      // 成功:ws.unlock 内部已 emit 'workspace:unlocked' → app 会调 unmount(),此处容错再调一次
      unmount();
      util.toast('已解锁,可以继续工作', 'ok');
    } catch (e) {
      st.msg.textContent = '解锁失败:' + (e && e.message || e);
      util.toast('解锁失败:' + (e && e.message || e), 'err');
    } finally {
      st.busy = false;
      if (st.unlockBtn) st.unlockBtn.classList.remove('is-loading');
    }
  }

  async function doClose() {
    if (st.busy) return;
    var ok = await util.confirmDialog({
      title: '关闭工作区',
      body: '锁定状态下密钥与映射已清除,直接关闭不会丢失已保存的本机副本,但未保存的变更将丢失。确定关闭并回到首页吗?',
      confirmText: '关闭并回首页'
    });
    if (!ok) return;
    unmount();
    if (E.ui.app && typeof E.ui.app.closeWorkspace === 'function') E.ui.app.closeWorkspace();
  }

  function mount() {
    if (st.el) return; // 已显示
    var ws = workspace.current;
    if (!ws) return;

    st.input = util.el('input', {
      class: 'input ec-lock-input', type: 'password',
      autocomplete: 'current-password', placeholder: '输入主密码解锁'
    });
    st.msg = util.el('div', { class: 'ec-lock-msg', text: '' });
    st.unlockBtn = util.el('button', { class: 'btn btn-primary', type: 'button', text: '解锁' });
    st.unlockBtn.addEventListener('click', doUnlock);
    st.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doUnlock(); });

    var closeBtn = util.el('button', { class: 'btn', type: 'button', text: '关闭工作区回首页' });
    closeBtn.addEventListener('click', doClose);

    st.el = util.el('div', { class: 'ec-lock' }, [
      util.el('div', { class: 'ec-lock-box' }, [
        util.el('span', { html: LOCK_SVG }), // 静态 SVG
        util.el('div', { class: 'ec-lock-title', text: '🔒 工作区已锁定' }),
        util.el('div', { class: 'ec-lock-ws', text: ws.name }),
        util.el('div', { class: 'ec-lock-desc', text: '已自动锁定 — 密钥与映射已从内存清除,输入主密码重新解密。' }),
        st.input,
        st.msg,
        util.el('div', { class: 'ec-lock-btns' }, [closeBtn, st.unlockBtn])
      ])
    ]);
    var host = document.getElementById('ec-overlay-root') || document.body;
    host.appendChild(st.el);
    setTimeout(function () { if (st.input) st.input.focus(); }, 60);

    // 容错:其他路径解锁成功时也能撤下遮罩
    st.busHandler = function () { unmount(); };
    util.bus.on('workspace:unlocked', st.busHandler);
  }

  function unmount() {
    if (st.busHandler) { util.bus.off('workspace:unlocked', st.busHandler); st.busHandler = null; }
    if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el);
    st.el = null; st.input = null; st.msg = null; st.unlockBtn = null; st.busy = false;
  }

  return { mount: mount, unmount: unmount, isShown: function () { return !!st.el; } };
});
