// 起動監視スクリプト。他のアプリJSより先に読み込む。
// window.portalStartup APIを公開し、起動タイムアウトと例外を監視する。
(function () {
    'use strict';

    // 二重初期化防止
    if (window.portalStartup) return;

    var STARTUP_TIMEOUT_MS = 15000;
    var _startTime = Date.now();
    var _marks = [];
    var _isReady = false;
    var _appReadyRecorded = false;  // Phase 2 計測: APP_READY 二重記録防止
    var _errorHandlersRegistered = false;
    var _retryInFlight = false;
    var _watchdogTimer = null;

    function _getEl(id) {
        return document.getElementById(id);
    }

    function _setMessage(message) {
        var el = _getEl('portalStartupMessage');
        if (el) el.textContent = String(message || '');
    }

    // 再試行ボタンを表示し、クリック時にretryFnを1回だけ実行する
    function _showRetry(opts) {
        var message = (opts && opts.message) ? opts.message : '通信に時間がかかっています。再試行してください。';
        var retryFn = (opts && typeof opts.retry === 'function') ? opts.retry : null;
        _setMessage(message);

        var reloadBtn = _getEl('portalStartupReloadButton');
        if (reloadBtn) reloadBtn.hidden = true;

        var retryBtn = _getEl('portalStartupRetryButton');
        if (!retryBtn) return;

        // cloneNodeで既存ハンドラを除去し重複登録を防ぐ
        var newBtn = retryBtn.cloneNode(true);
        retryBtn.parentNode.replaceChild(newBtn, retryBtn);
        newBtn.hidden = false;

        newBtn.addEventListener('click', function () {
            if (_retryInFlight) return;
            _retryInFlight = true;
            newBtn.disabled = true;
            var result;
            try {
                result = retryFn ? retryFn() : null;
            } catch (e) {
                console.error('[portalStartup] retry threw synchronously:', e);
                _retryInFlight = false;
                newBtn.disabled = false;
                return;
            }
            if (result && typeof result.then === 'function') {
                result.then(function () {
                    _retryInFlight = false;
                }).catch(function (e) {
                    console.error('[portalStartup] retry failed:', e);
                    _retryInFlight = false;
                    newBtn.disabled = false;
                });
            } else {
                _retryInFlight = false;
            }
        }, { once: true });
    }

    // 再読み込みボタンを表示し、クリック時にlocation.reloadを実行する
    function _showReload(message) {
        _setMessage(message || '起動処理を完了できませんでした。');

        var retryBtn = _getEl('portalStartupRetryButton');
        if (retryBtn) retryBtn.hidden = true;

        var reloadBtn = _getEl('portalStartupReloadButton');
        if (!reloadBtn) return;

        var newBtn = reloadBtn.cloneNode(true);
        reloadBtn.parentNode.replaceChild(newBtn, reloadBtn);
        newBtn.hidden = false;
        newBtn.addEventListener('click', function () {
            window.location.reload();
        }, { once: true });
    }

    // 起動完了: 監視タイマーを解除し、APP_READYを記録して、起動画面を非表示にする
    function _ready() {
        if (_isReady) return;
        _isReady = true;
        if (_watchdogTimer !== null) {
            clearTimeout(_watchdogTimer);
            _watchdogTimer = null;
        }
        // Phase 2 計測: APP_READY を1回だけ記録
        if (!_appReadyRecorded) {
            _appReadyRecorded = true;
            _mark('APP_READY');
        }
        var panel = _getEl('portalStartupPanel');
        if (panel) panel.hidden = true;
    }

    // Phase 2向けの最小計測実装
    function _mark(name, detail) {
        _marks.push({
            name: String(name || ''),
            elapsedMs: Date.now() - _startTime,
            detail: (detail !== undefined) ? detail : null,
        });
    }

    function _snapshot() {
        return {
            startTime: _startTime,
            marks: _marks.slice(),
            isReady: _isReady,
        };
    }

    function _onWatchdogTimeout() {
        if (_isReady) return;
        console.error('[portalStartup] watchdog timeout after ' + STARTUP_TIMEOUT_MS + 'ms');
        _showRetry({
            message: '通信に時間がかかっています。再試行してください。',
            retry: function () { window.location.reload(); },
        });
    }

    // window.onerror / unhandledrejection を登録する (二重登録防止付き)
    function _registerErrorHandlers() {
        if (_errorHandlersRegistered) return;
        _errorHandlersRegistered = true;

        window.addEventListener('error', function (event) {
            if (_isReady) return;
            console.error('[portalStartup] uncaught error:', event && event.message);
            _showReload('起動処理を完了できませんでした。');
        });

        window.addEventListener('unhandledrejection', function (event) {
            if (_isReady) return;
            console.error('[portalStartup] unhandled rejection:', event && event.reason);
            _showReload('起動処理を完了できませんでした。');
        });
    }

    // 起動開始を記録し、監視タイマーとエラーハンドラを設定する
    _mark('APP_START');
    _watchdogTimer = setTimeout(_onWatchdogTimeout, STARTUP_TIMEOUT_MS);
    _registerErrorHandlers();

    window.portalStartup = {
        mark: _mark,
        setMessage: _setMessage,
        showRetry: _showRetry,
        showReload: _showReload,
        ready: _ready,
        snapshot: _snapshot,
    };
})();
