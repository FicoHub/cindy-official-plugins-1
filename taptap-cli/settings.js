'use strict';

// Settings page for the TapTap CLI plugin.
//
// The only configurable value is an optional absolute path to taptap-cli, used
// when the worker cannot find it on PATH. Nothing here touches credentials:
// those live in the CLI's own credential store, never in the plugin.

(function () {
  var CHANNEL = 'taptap-cli';

  var MESSAGES = {
    en: {
      intro: 'This plugin runs the official taptap-cli you installed on this machine; it does not bundle a binary. Install and authorize it in a terminal first:',
      pathLabel: 'CLI path (optional)',
      pathPlaceholder: 'Leave empty to auto-detect PATH, ~/.local/bin, and other common locations',
      save: 'Save',
      pathHint: 'Fill this in only when auto-detection fails, for example /opt/homebrew/bin/taptap-cli. Only a program named taptap-cli is accepted, and a wrong path reports an error.',
      saved: 'Saved.',
      cleared: 'Cleared; auto-detection will be used.',
      saveFailed: 'Could not save: '
    },
    'zh-CN': {
      intro: '本插件调用你本机已安装的官方 taptap-cli,不随包分发二进制。先在终端完成安装与授权:',
      pathLabel: 'CLI 路径(可选)',
      pathPlaceholder: '留空则自动查找 PATH、~/.local/bin 等常见位置',
      save: '保存',
      pathHint: '仅当自动查找失败时填写,例如 /opt/homebrew/bin/taptap-cli。只接受以 taptap-cli 命名的程序,填错会直接报错。',
      saved: '已保存。',
      cleared: '已清空,将使用自动查找。',
      saveFailed: '保存失败:'
    },
    ja: {
      intro: 'このプラグインは、このマシンにインストール済みの公式 taptap-cli を実行します。バイナリは同梱しません。先にターミナルでインストールと認証を済ませてください:',
      pathLabel: 'CLI パス(任意)',
      pathPlaceholder: '空欄なら PATH や ~/.local/bin などから自動検出します',
      save: '保存',
      pathHint: '自動検出に失敗した場合のみ入力してください(例: /opt/homebrew/bin/taptap-cli)。taptap-cli という名前のプログラムのみ受け付け、誤ったパスはエラーになります。',
      saved: '保存しました。',
      cleared: 'クリアしました。自動検出を使用します。',
      saveFailed: '保存できませんでした:'
    },
    ko: {
      intro: '이 플러그인은 이 컴퓨터에 설치된 공식 taptap-cli 를 실행하며, 바이너리를 함께 배포하지 않습니다. 먼저 터미널에서 설치와 인증을 완료하세요:',
      pathLabel: 'CLI 경로(선택)',
      pathPlaceholder: '비워 두면 PATH, ~/.local/bin 등에서 자동으로 찾습니다',
      save: '저장',
      pathHint: '자동 검색이 실패할 때만 입력하세요(예: /opt/homebrew/bin/taptap-cli). taptap-cli 라는 이름의 프로그램만 허용하며, 잘못된 경로는 오류로 알려줍니다.',
      saved: '저장했습니다.',
      cleared: '지웠습니다. 자동 검색을 사용합니다.',
      saveFailed: '저장하지 못했습니다: '
    }
  };

  var currentLocale = 'en';

  function normalizeLocale(locale) {
    return Object.prototype.hasOwnProperty.call(MESSAGES, locale) ? locale : 'en';
  }

  function t(key) {
    return (MESSAGES[currentLocale] && MESSAGES[currentLocale][key]) || MESSAGES.en[key] || key;
  }

  function applyStaticTranslations() {
    document.documentElement.lang = currentLocale;
    document.querySelectorAll('[data-i18n]').forEach(function (element) {
      element.textContent = t(element.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (element) {
      element.setAttribute('placeholder', t(element.getAttribute('data-i18n-placeholder')));
    });
  }

  function loadHostLocale() {
    return fetch('/app-context')
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (result) {
        currentLocale = normalizeLocale(result && result.context && result.context.locale);
      })
      .catch(function () { currentLocale = 'en'; });
  }

  var input = document.getElementById('cli_path');
  var button = document.getElementById('save');
  var status = document.getElementById('status');

  function setStatus(text) {
    status.textContent = text;
  }

  button.addEventListener('click', function () {
    var value = input.value.trim();
    var body = value ? { cli_path: value } : {};
    fetch('/kv', { method: 'PUT', body: JSON.stringify(body) })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        setStatus(value ? t('saved') : t('cleared'));
        try {
          new BroadcastChannel(CHANNEL).postMessage({ type: 'settings-changed' });
        } catch (_) {
          // The brain re-reads /kv on its next wake; a missing channel is fine.
        }
      })
      .catch(function (error) {
        setStatus(t('saveFailed') + ((error && error.message) || String(error)));
      });
  });

  Promise.all([
    loadHostLocale(),
    fetch('/kv')
      .then(function (response) { return response.json(); })
      .catch(function () { return {}; })
  ]).then(function (results) {
    var cfg = results[1] || {};
    input.value = typeof cfg.cli_path === 'string' ? cfg.cli_path : '';
    applyStaticTranslations();
  });
})();
