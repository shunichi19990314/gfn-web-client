// フロントエンドMVP: デバイスフローログイン(QR/手動コード)+ トークンインポート + ライブラリ表示
// 依存ライブラリなし(バニラJS)。バックエンドは同一オリジンの /api/*

const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  providers: [],
  games: [],
  cursor: '',
  hasNextPage: false,
  totalCount: 0,
  searchQuery: '',
  loginMode: 'qr', // 'qr' | 'code'
  loginAttempt: null, // { attemptId, deviceCode, intervalMs, expiresAt, timer, countdownTimer }
};

// ---------- ユーティリティ ----------

function showToast(message, ms = 5000) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), ms);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message ?? `HTTP ${response.status}`);
    error.code = payload?.error ?? 'http_error';
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showView(name) {
  $('view-login').classList.toggle('hidden', name !== 'login');
  $('view-library').classList.toggle('hidden', name !== 'library');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('コピーしました', 1500);
  } catch {
    showToast('コピーに失敗しました。手動で選択してコピーしてください。');
  }
}

// ---------- ログイン: タブ ----------

const TAB_HINTS = {
  qr: 'スマートフォンのカメラでQRコードをスキャンして承認します。',
  code: 'この端末でNVIDIAのコード入力ページを開き、8桁のコードを入力します(スマートフォン不要)。',
};

function setLoginMode(mode) {
  state.loginMode = mode;
  $('tab-qr').classList.toggle('active', mode === 'qr');
  $('tab-code').classList.toggle('active', mode === 'code');
  $('tab-hint').textContent = TAB_HINTS[mode];
}

// ---------- ログイン: デバイスフロー ----------

async function loadProviders() {
  try {
    const { providers } = await api('/api/providers');
    state.providers = providers;
    const select = $('provider-select');
    select.innerHTML = '';
    for (const provider of providers) {
      const option = document.createElement('option');
      option.value = provider.idpId;
      option.textContent = `${provider.displayName} (${provider.code})`;
      select.appendChild(option);
    }
  } catch (error) {
    showToast(`プロバイダ取得に失敗: ${error.message}`);
  }
}

async function startDeviceLogin() {
  const providerIdpId = $('provider-select').value || undefined;
  $('start-login-btn').disabled = true;
  try {
    const auth = await api('/api/auth/device/start', {
      method: 'POST',
      body: JSON.stringify({ providerIdpId }),
    });
    state.loginAttempt = {
      attemptId: auth.attemptId,
      deviceCode: auth.deviceCode,
      userCode: auth.userCode,
      verificationUriComplete: auth.verificationUriComplete,
      intervalMs: (auth.intervalSeconds || 5) * 1000,
      expiresAt: auth.expiresAt,
    };
    $('login-idle').classList.add('hidden');
    $('login-pending').classList.remove('hidden');
    // QRパネル
    $('pending-qr').classList.toggle('hidden', state.loginMode !== 'qr');
    $('pending-code').classList.toggle('hidden', state.loginMode !== 'code');
    $('qr-image').src = auth.qrDataUrl;
    $('user-code').textContent = auth.userCode;
    $('user-code-big').textContent = auth.userCode;
    const link = $('verification-link');
    link.href = auth.verificationUriComplete;
    link.textContent = 'コード入力ページ(コード入力済みリンク)';
    const openBtn = $('open-pin-page-btn');
    openBtn.href = auth.verificationUriComplete;
    setLoginStatus('承認待ち… (NVIDIA IDでログインし、コードを承認してください)');
    startCountdown();
    schedulePoll();
  } catch (error) {
    showToast(`ログイン開始に失敗: ${error.message}`);
    $('start-login-btn').disabled = false;
  }
}

function setLoginStatus(text, isError = false) {
  for (const id of ['login-status', 'login-status2']) {
    const line = $(id);
    line.textContent = text;
    line.classList.toggle('error', isError);
  }
}

function startCountdown() {
  const update = () => {
    if (!state.loginAttempt) return;
    const remaining = Math.max(0, Math.floor((state.loginAttempt.expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = String(remaining % 60).padStart(2, '0');
    const text = remaining > 0 ? `${minutes}:${seconds}` : '期限切れ';
    $('expiry-countdown').textContent = text;
    $('expiry-countdown2').textContent = text;
    if (remaining <= 0) {
      cancelLogin('expired');
      setLoginStatus('コードの有効期限が切れました。やり直してください。', true);
      resetLoginUi();
    }
  };
  update();
  state.loginAttempt.countdownTimer = setInterval(update, 1000);
}

function schedulePoll(delayMs = state.loginAttempt?.intervalMs ?? 5000) {
  if (!state.loginAttempt) return;
  state.loginAttempt.timer = setTimeout(pollLogin, delayMs);
}

async function pollLogin() {
  const attempt = state.loginAttempt;
  if (!attempt) return;
  let result;
  try {
    result = await api('/api/auth/device/poll', {
      method: 'POST',
      body: JSON.stringify({ attemptId: attempt.attemptId, deviceCode: attempt.deviceCode }),
    });
  } catch (error) {
    setLoginStatus(`ポーリングエラー: ${error.message} — 再試行します`, true);
    schedulePoll(5000);
    return;
  }
  switch (result.status) {
    case 'pending':
      setLoginStatus('承認待ち…');
      schedulePoll();
      break;
    case 'slow_down':
      setLoginStatus('待機中(ポーリング間隔を延長)…');
      attempt.intervalMs = (result.intervalSeconds || 10) * 1000;
      schedulePoll(attempt.intervalMs);
      break;
    case 'authorized':
      setLoginStatus('承認されました。セッションを確立中…');
      await completeLogin();
      break;
    case 'expired':
      setLoginStatus(result.error || '期限切れ', true);
      cancelLogin('expired');
      resetLoginUi();
      break;
    case 'access_denied':
      setLoginStatus(result.error || '承認が拒否されました', true);
      cancelLogin('denied');
      resetLoginUi();
      break;
    default:
      setLoginStatus(result.error || '不明なエラー', true);
      cancelLogin('error');
      resetLoginUi();
  }
}

async function completeLogin() {
  try {
    const { session } = await api('/api/auth/device/complete', {
      method: 'POST',
      body: JSON.stringify({ attemptId: state.loginAttempt.attemptId, staySignedIn: true }),
    });
    cancelLogin('complete');
    state.session = session;
    await enterLibrary();
  } catch (error) {
    setLoginStatus(`セッション確立に失敗: ${error.message}`, true);
    resetLoginUi();
  }
}

function cancelLogin(_reason) {
  const attempt = state.loginAttempt;
  if (!attempt) return;
  clearTimeout(attempt.timer);
  clearInterval(attempt.countdownTimer);
  state.loginAttempt = null;
  if (_reason !== 'complete' && _reason !== 'expired') {
    api('/api/auth/device/cancel', {
      method: 'POST',
      body: JSON.stringify({ attemptId: attempt.attemptId }),
    }).catch(() => {});
  }
}

function resetLoginUi() {
  $('login-pending').classList.add('hidden');
  $('login-idle').classList.remove('hidden');
  $('start-login-btn').disabled = false;
}

// ---------- ログイン: トークンインポート ----------

async function importToken() {
  const token = $('import-token').value.trim();
  const statusEl = $('import-status');
  if (!token) {
    statusEl.textContent = 'トークンを貼り付けてください。';
    statusEl.classList.add('error');
    return;
  }
  $('import-btn').disabled = true;
  statusEl.classList.remove('error');
  statusEl.textContent = '検証中… (NVIDIA APIでトークンの有効性を確認します)';
  try {
    const { session } = await api('/api/auth/token/import', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    state.session = session;
    $('import-token').value = '';
    statusEl.textContent = '';
    await enterLibrary();
  } catch (error) {
    statusEl.textContent = `インポート失敗: ${error.message}`;
    statusEl.classList.add('error');
  } finally {
    $('import-btn').disabled = false;
  }
}

// ---------- ログアウト / ライブラリ ----------

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* サーバー側はCookieなしでも無害 */ }
  state.session = null;
  state.games = [];
  $('game-grid').innerHTML = '';
  $('user-chip').classList.add('hidden');
  resetLoginUi();
  showView('login');
}

function renderUserChip(session) {
  $('user-chip').classList.remove('hidden');
  $('user-name').textContent = session.user.displayName ?? session.user.email ?? 'User';
  const tier = session.user.membershipTier ?? '';
  $('user-tier').textContent = session.imported ? `${tier} • インポート` : tier;
  const avatar = $('user-avatar');
  if (session.user.avatarUrl) {
    avatar.src = session.user.avatarUrl;
    avatar.classList.remove('hidden');
  } else {
    avatar.classList.add('hidden');
  }
}

async function loadSubscription() {
  try {
    const { subscription, vpcId } = await api('/api/subscription');
    $('sub-tier').textContent = subscription.membershipTier;
    const remaining = subscription.remainingTimeInMinutes;
    $('sub-time').textContent =
      subscription.membershipTier === 'FREE'
        ? `残り ${Math.round(remaining)} 分 / 総額 ${Math.round(subscription.totalTimeInMinutes)} 分`
        : `セッション上限: ${remaining > 0 ? `${Math.round(remaining)} 分残り` : '無制限'}`;
    $('sub-region').textContent = `vpcId: ${vpcId}`;
    const resolutions = (subscription.resolutions ?? []).slice(0, 4);
    $('sub-resolutions').textContent = resolutions.length
      ? `解像度権限: ${resolutions.map((r) => `${r.width}x${r.height}@${r.fps}`).join(' / ')}`
      : '';
    if (state.session) {
      state.session.user.membershipTier = subscription.membershipTier;
      renderUserChip(state.session);
    }
  } catch (error) {
    $('sub-tier').textContent = '取得失敗';
    $('sub-time').textContent = error.message;
  }
}

async function loadRegions() {
  try {
    const info = await api('/api/regions');
    const local = info.localRegion ?? '(unknown)';
    $('sub-region').textContent = `local-region: ${local} / リージョン数: ${info.regions?.length ?? 0} / vpcId: ${info.vpcId ?? '—'}`;
  } catch { /* 表示は購読パネルのフォールバックのまま */ }
}

async function loadLibraryPage({ reset = false } = {}) {
  const statusEl = $('library-status');
  const loadMoreBtn = $('load-more-btn');
  if (reset) {
    state.games = [];
    state.cursor = '';
    state.hasNextPage = false;
    $('game-grid').innerHTML = '';
  }
  loadMoreBtn.disabled = true;
  statusEl.textContent = 'ライブラリを読み込み中…';
  try {
    const page = await api(`/api/library${state.cursor ? `?cursor=${encodeURIComponent(state.cursor)}` : ''}`);
    state.games.push(...page.games);
    state.cursor = page.nextCursor ?? '';
    state.hasNextPage = page.hasNextPage;
    state.totalCount = page.totalCount;
    renderGames();
    statusEl.textContent = `${state.games.length} / ${state.totalCount} タイトル読み込み済み`;
    loadMoreBtn.classList.toggle('hidden', !state.hasNextPage);
  } catch (error) {
    statusEl.textContent = '';
    showToast(`ライブラリ取得に失敗: ${error.message}`);
    if (error.status === 401) {
      await logout();
    }
  } finally {
    loadMoreBtn.disabled = false;
  }
}

function renderGames() {
  const grid = $('game-grid');
  const template = $('game-card-template');
  const query = state.searchQuery.trim().toLowerCase();
  const visible = query ? state.games.filter((g) => g.searchText.includes(query)) : state.games;
  grid.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const game of visible) {
    const node = template.content.firstElementChild.cloneNode(true);
    const img = node.querySelector('.cover img');
    if (game.imageUrl) {
      img.src = game.imageUrl;
      img.alt = game.title;
    } else {
      img.remove();
    }
    const tierTag = node.querySelector('.tier-tag');
    const tier = (game.membershipTierLabel ?? '').toUpperCase();
    if (tier) {
      tierTag.textContent = tier;
      tierTag.classList.toggle('free', tier === 'FREE');
    } else {
      tierTag.remove();
    }
    node.querySelector('.game-title').textContent = game.title;
    node.querySelector('.game-meta').textContent = [game.publisherName, game.developerName].filter(Boolean).join(' / ') || '\u00a0';
    const badges = node.querySelector('.game-badges');
    for (const store of game.availableStores ?? []) {
      const badge = document.createElement('span');
      badge.textContent = store;
      badges.appendChild(badge);
    }
    if (game.lastPlayed) {
      const badge = document.createElement('span');
      badge.textContent = `最終プレイ: ${String(game.lastPlayed).slice(0, 10)}`;
      badges.appendChild(badge);
    }
    node.querySelector('.launch-id').textContent = game.launchAppId ? `appId ${game.launchAppId}` : 'launch id なし';
    fragment.appendChild(node);
  }
  grid.appendChild(fragment);
  $('library-count').textContent = query ? `${visible.length} 件一致` : '';
}

async function enterLibrary() {
  renderUserChip(state.session);
  showView('library');
  await Promise.all([loadLibraryPage({ reset: true }), loadSubscription(), loadRegions()]);
}

// ---------- 初期化 ----------

async function init() {
  setLoginMode('qr');
  $('tab-qr').addEventListener('click', () => setLoginMode('qr'));
  $('tab-code').addEventListener('click', () => setLoginMode('code'));
  $('start-login-btn').addEventListener('click', startDeviceLogin);
  for (const id of ['cancel-login-btn', 'cancel-login-btn2']) {
    $(id).addEventListener('click', () => {
      cancelLogin('user');
      setLoginStatus('キャンセルしました。');
      resetLoginUi();
    });
  }
  $('copy-code-btn').addEventListener('click', () => copyText(state.loginAttempt?.userCode ?? ''));
  $('copy-code-btn2').addEventListener('click', () => copyText(state.loginAttempt?.userCode ?? ''));
  $('import-btn').addEventListener('click', importToken);
  $('logout-btn').addEventListener('click', logout);
  $('load-more-btn').addEventListener('click', () => loadLibraryPage());
  $('search-input').addEventListener('input', (event) => {
    state.searchQuery = event.target.value;
    renderGames();
  });

  await loadProviders();
  try {
    const { session } = await api('/api/session');
    if (session) {
      state.session = session;
      await enterLibrary();
      return;
    }
  } catch { /* 未ログイン */ }
  showView('login');
}

init().catch((error) => showToast(`初期化エラー: ${error.message}`));
