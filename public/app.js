// フロントエンド: デバイスフローログイン(QR/手動コード)+ トークンインポート + ライブラリ表示
// + Phase 2A: ゲーム起動 → セッション確立 → NVSTシグナリング → WebRTC映像受信
import { NvstSignalingClient } from './js/signaling.js';
import { GfnStream } from './js/stream.js';

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
  launchGame: null, // 起動対象のゲーム
  regionsForLaunch: null, // /api/regions のキャッシュ
  stream: null, // { gfnStream, signaling, pollTimer, sessionInfo, startedAt }
  adRuntime: null, // { adId, index, lastAction, startedAtMs, wasPaused, startWatchdog, stuckWatchdog, lastProgressTs, reportedFinish }
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
    error.payload = payload;
    throw error;
  }
  return payload;
}

function showView(name) {
  $('view-login').classList.toggle('hidden', name !== 'login');
  $('view-library').classList.toggle('hidden', name !== 'library');
  $('view-stream').classList.toggle('hidden', name !== 'stream');
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
      expiresAt: auth.expiresAt,
      intervalMs: (auth.intervalSeconds || 5) * 1000,
    };
    $('login-idle').classList.add('hidden');
    $('login-pending').classList.remove('hidden');
    $('pending-qr').classList.toggle('hidden', state.loginMode !== 'qr');
    $('pending-code').classList.toggle('hidden', state.loginMode !== 'code');
    $('qr-image').src = auth.qrDataUrl;
    $('user-code').textContent = auth.userCode;
    $('user-code-big').textContent = auth.userCode;
    const link = $('verification-link');
    link.href = auth.verificationUriComplete;
    link.textContent = 'コード入力ページ(コード入力済みリンク)';
    $('open-pin-page-btn').href = auth.verificationUriComplete;
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
    const text = remaining > 0 ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '期限切れ';
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
  await stopStream({ silent: true });
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
    if (error.status === 401) await logout();
  } finally {
    loadMoreBtn.disabled = false;
  }
}

function parseEndTime(value) {
  if (value === null || value === undefined) return null;
  let date = null;
  if (typeof value === 'number') date = new Date(value > 1e12 ? value : value * 1000);
  else if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    date = new Date(n > 1e12 ? n : n * 1000);
  } else if (typeof value === 'string') {
    date = new Date(value);
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatUpdateHint(game) {
  const end = parseEndTime(game.updateEndTime);
  if (game.inMaintenance) return end ? `メンテナンス(〜${end}頃)` : 'メンテナンス中';
  return end ? `更新中(〜${end}頃)` : 'サーバー更新中';
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
    if (game.patchLevel === 'auto' || game.inMaintenance) {
      const badge = document.createElement('span');
      badge.className = 'warning';
      badge.textContent = game.inMaintenance ? 'メンテナンス中' : 'サーバー更新中';
      badges.appendChild(badge);
    } else if (game.patchLevel === 'manual') {
      const badge = document.createElement('span');
      badge.className = 'warning';
      badge.textContent = '手動更新待ち';
      badges.appendChild(badge);
    }
    const launchBtn = node.querySelector('.launch-btn');
    const blocked = game.patchLevel === 'auto' || game.inMaintenance;
    if (game.launchAppId && !blocked) {
      node.querySelector('.launch-id').textContent = `appId ${game.launchAppId}`;
      launchBtn.addEventListener('click', () => openLaunchModal(game));
    } else {
      node.querySelector('.launch-id').textContent = blocked
        ? formatUpdateHint(game)
        : 'launch id なし';
      launchBtn.disabled = true;
      launchBtn.title = blocked
        ? 'NVIDIAサーバー側でこのゲームを更新中です。通常は数時間で再開されます'
        : '数値のlaunchAppIdがないため起動できません';
    }
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

// ---------- Phase 2A: ゲーム起動 → 映像受信 ----------

// リージョン選択
const REGION_STORAGE_KEY = 'gfnweb_region';
const ZONE_CITY_NAMES = {
  TYO: '東京', NRT: '東京', LAX: 'ロサンゼルス', SJC: 'サンノゼ', SEA: 'シアトル',
  DEN: 'デンバー', DAL: 'ダラス', ATL: 'アトランタ', MIA: 'マイアミ', ORD: 'シカゴ',
  ASH: 'アッシュバーン', IAD: 'アッシュバーン', EWR: 'ニューアーク', BOS: 'ボストン',
  YYZ: 'トロント', YUL: 'モントリオール', AMS: 'アムステルダム', FRA: 'フランクフルト',
  LON: 'ロンドン', PAR: 'パリ', MAD: 'マドリード', MIL: 'ミラノ', STO: 'ストックホルム',
  OSL: 'オスロ', HEL: 'ヘルシンキ', CPH: 'コペンハーゲン', WAW: 'ワルシャワ',
  SGP: 'シンガポール', SYD: 'シドニー', MEL: 'メルボルン', AKL: 'オークランド',
};

function regionLabel(region) {
  // "NP-TYO-01" / "np-tyo-01.cloudmatchbeta..." → 都市名(推定)+ 原名
  const name = region.name ?? '';
  const codeMatch = name.toUpperCase().match(/-([A-Z]{3})-/);
  const city = codeMatch ? ZONE_CITY_NAMES[codeMatch[1]] : null;
  return city ? `${city} (${name})` : name;
}

async function populateRegionSelect() {
  const select = $('launch-region');
  const saved = localStorage.getItem(REGION_STORAGE_KEY) ?? 'auto';
  if (state.regionsForLaunch) {
    renderRegionOptions(select, state.regionsForLaunch, saved);
    return;
  }
  try {
    const info = await api('/api/regions');
    state.regionsForLaunch = info;
    renderRegionOptions(select, info, saved);
  } catch (error) {
    select.innerHTML = '<option value="auto" selected>自動(リージョン取得失敗: 再ログインで再試行)</option>';
  }
}

function renderRegionOptions(select, info, saved) {
  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = '自動(サーバーにおまかせ)';
  select.appendChild(auto);
  const regions = info.regions ?? [];
  // local-region を先頭に
  const sorted = [...regions].sort((a, b) => {
    const la = a.name === info.localRegion ? 0 : 1;
    const lb = b.name === info.localRegion ? 0 : 1;
    return la - lb || a.name.localeCompare(b.name);
  });
  let savedExists = false;
  for (const region of sorted) {
    const option = document.createElement('option');
    option.value = region.url;
    const local = region.name === info.localRegion ? ' ★local' : '';
    const baseLabel = `${regionLabel(region)}${local}`;
    option.dataset.baseLabel = baseLabel;
    option.textContent = baseLabel;
    option.dataset.regionName = region.name;
    if (region.url === saved) savedExists = true;
    select.appendChild(option);
  }
  select.value = savedExists ? saved : 'auto';
}

async function measureRegionLatency() {
  const info = state.regionsForLaunch;
  if (!info?.regions?.length) return;
  const btn = $('region-ping-btn');
  const statusEl = $('region-ping-status');
  btn.disabled = true;
  statusEl.textContent = '計測中…';
  const select = $('launch-region');
  const measure = async (url) => {
    const target = `${url.replace(/\/$/, '')}/v2/serverInfo`;
    const once = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const start = performance.now();
      try {
        await fetch(target, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
        return Math.round(performance.now() - start);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };
    await once(); // ウォームアップ(DNS/TCP経路を慣らす — regionPing.ts に倣う)
    const samples = [];
    for (let i = 0; i < 2; i++) {
      const ms = await once();
      if (ms !== null) samples.push(ms);
    }
    return samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null;
  };
  // 並列4で全リージョンを計測
  const queue = [...info.regions];
  const results = new Map();
  const worker = async () => {
    while (queue.length > 0) {
      const region = queue.shift();
      results.set(region.url, await measure(region.url));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const option of select.options) {
    if (option.value === 'auto') continue;
    const ms = results.get(option.value);
    option.textContent = `${option.dataset.baseLabel ?? option.value} — ${ms !== null && ms !== undefined ? `${ms}ms` : '計測失敗'}`;
  }
  statusEl.textContent = `計測完了(${results.size}リージョン)。数値はTLS接続込みのおおよその往復時間です。`;
  btn.disabled = false;
}

function openLaunchModal(game) {
  state.launchGame = game;
  $('launch-title').textContent = `${game.title} を起動`;
  $('region-ping-status').textContent = '';
  populateRegionSelect();
  const modal = $('launch-modal');
  if (!modal.open) modal.showModal();
}

function collectLaunchSettings() {
  const [resolution, fps, maxBitrateMbps, keyboardLayout, gameLanguage] = [
    $('launch-resolution').value,
    Number($('launch-fps').value),
    Number($('launch-bitrate').value),
    $('launch-keyboard').value,
    $('launch-language').value,
  ];
  return { resolution, fps, maxBitrateMbps, keyboardLayout, gameLanguage };
}

function setStreamStatus(text, detail = '') {
  $('stream-status-text').textContent = text;
  $('stream-status-detail').textContent = detail;
}

function streamLog(message) {
  const log = $('stream-log');
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  log.appendChild(line);
  while (log.childElementCount > 200) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

async function launchGame() {
  const game = state.launchGame;
  if (!game?.launchAppId) return;
  const settings = collectLaunchSettings();
  showView('stream');
  $('stream-log').innerHTML = '';
  $('stream-log').classList.remove('hidden');
  $('stream-game-title').textContent = game.title;
  $('stream-session-meta').textContent = '';
  $('stream-stats').classList.add('hidden');
  $('stream-status-card').classList.remove('hidden');
  setStreamStatus('CloudMatchセッションを作成中…', `appId ${game.launchAppId} / ${settings.resolution}@${settings.fps} / ${settings.maxBitrateMbps}Mbps / リージョン: ${regionText}`);

  const selectedRegion = $('launch-region').value;
  localStorage.setItem(REGION_STORAGE_KEY, selectedRegion);
  const regionOption = $('launch-region').selectedOptions[0];
  const regionText = selectedRegion === 'auto' ? '自動' : (regionOption?.dataset?.baseLabel ?? selectedRegion);
  let info;
  try {
    ({ session: info } = await api('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({
        appId: game.launchAppId,
        title: game.title,
        settings,
        region: selectedRegion === 'auto' ? undefined : selectedRegion,
      }),
    }));
  } catch (error) {
    if (error.code === 'session_conflict') {
      if (error.payload?.session?.sessionId) {
        // 同一ブラウザの既存セッション → それに復帰
        state.stream = { gfnStream: null, signaling: null, pollTimer: null, sessionInfo: error.payload.session, startedAt: Date.now() };
        setStreamStatus('既存セッションに復帰します…');
        startSessionPolling();
        return;
      }
      await handleSessionConflict(error);
      return;
    }
    const kind = error.payload?.kind;
    setStreamStatus('セッション作成に失敗', error.message);
    // 再試行が有効なエラー(更新中/混雑系)はリトライボタンを提供
    const retryable = ['app_patching', 'app_maintenance', 'capacity', 'queue_full', 'unavailable', 'forwarding'].includes(kind);
    if (retryable) {
      const btn = $('stream-cancel-btn');
      btn.textContent = kind === 'app_patching' ? '60秒後に再試行' : '再試行';
      btn.disabled = false;
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'キャンセル';
        btn.onclick = null;
        if (kind === 'app_patching') await new Promise((resolve) => setTimeout(resolve, 60_000));
        await launchGame();
      };
    }
    return;
  }
  state.stream = { gfnStream: null, signaling: null, pollTimer: null, sessionInfo: info, startedAt: Date.now() };
  setStreamStatus(`セッション準備中… (status=${info.status} ${info.phase})`);
  startSessionPolling();
}

async function handleSessionConflict(error) {
  const sessions = error.payload?.sessions ?? [];
  if (sessions.length === 0) {
    setStreamStatus('既にアクティブなセッションがあります', error.message);
    return;
  }
  const target = sessions[0];
  setStreamStatus('他のデバイスでセッションが実行中', `sessionId: ${target.sessionId} (status=${target.phase})`);
  const stopBtn = $('stream-cancel-btn');
  stopBtn.textContent = '既存セッションを停止して戻る';
  stopBtn.onclick = async () => {
    stopBtn.disabled = true;
    try {
      await api('/api/session/remote/stop', {
        method: 'POST',
        body: JSON.stringify({ sessionId: target.sessionId, serverIp: target.serverIp, streamingBaseUrl: target.streamingBaseUrl }),
      });
      showToast('既存セッションを停止しました。もう一度起動してください。');
      stopBtn.textContent = 'キャンセル';
      stopBtn.onclick = null;
      await exitStreamView();
    } catch (stopError) {
      showToast(`停止に失敗: ${stopError.message}`);
      stopBtn.disabled = false;
    }
  };
}

function startSessionPolling() {
  const stream = state.stream;
  if (!stream) return;
  const deadline = Date.now() + 3 * 60 * 1000; // 3分タイムアウト
  const poll = async () => {
    if (!state.stream) return;
    if (Date.now() > deadline) {
      setStreamStatus('セッション準備がタイムアウトしました', '3分以内にreadyになりませんでした');
      return;
    }
    let info;
    try {
      ({ session: info } = await api('/api/session/poll'));
    } catch (error) {
      setStreamStatus('ポーリング失敗', error.message);
      state.stream.pollTimer = setTimeout(poll, 3000);
      return;
    }
    state.stream.sessionInfo = info;
    updateSessionUi(info);
    if ([2, 3].includes(info.status) && info.signalingUrl && info.iceServers?.length && !state.stream.gfnStream) {
      clearInterval(state.stream.pollTimer);
      state.stream.pollTimer = null;
      await beginStreaming(info);
      return; // ストリーミング開始後はポーリング停止
    }
    if (info.phase === 'failed') {
      setStreamStatus('セッションが失敗しました', `status=${info.status}`);
      return;
    }
    state.stream.pollTimer = setTimeout(poll, 1000);
  };
  stream.pollTimer = setTimeout(poll, 500);
}

function updateSessionUi(info) {
  const meta = [info.zone, info.gpuType, info.serverLocation].filter(Boolean).join(' / ');
  $('stream-session-meta').textContent = meta;

  // 観測性: 生の状態をdetailに常時表示し、phase変化をログに残す
  const detail = [
    `status=${info.status} (${info.phase})`,
    info.seatSetupStep != null ? `seatSetupStep=${info.seatSetupStep}` : null,
    info.queuePosition ? `queue=${info.queuePosition}` : null,
    info.adState?.isAdsRequired ? 'ads=required' : null,
    info.adState?.isQueuePaused ? 'queuePaused' : null,
    meta || null,
  ].filter(Boolean).join(' / ');
  const prevPhase = state.stream?.lastLoggedPhase;
  if (state.stream && prevPhase !== `${info.status}:${info.phase}:${info.queuePosition ?? ''}:${info.adState?.isAdsRequired ?? ''}`) {
    state.stream.lastLoggedPhase = `${info.status}:${info.phase}:${info.queuePosition ?? ''}:${info.adState?.isAdsRequired ?? ''}`;
    streamLog(`session: ${detail}`);
  }

  if (info.readyForConnect) {
    // beginStreaming 側でステータスを更新
  } else if (info.inQueue && info.adState?.isAdsRequired) {
    const ads = getPlayableAds(info);
    const finishedIds = state.adRuntime?.finishedIds ?? new Set();
    const pendingAds = ads.filter((ad) => !finishedIds.has(ad.adId));
    if (ads.length > 0 && pendingAds.length === 0) {
      setStreamStatus('広告の視聴が完了しました。GPUサーバーの割り当てを待っています…', detail);
    } else if (ads.length > 0) {
      setStreamStatus(info.queuePosition ? `待機行列 ${info.queuePosition} 番目 — 広告を再生します(無料枠)` : '広告を再生します(無料枠のキュー広告)', detail);
    } else {
      setStreamStatus('Ad Break — 広告メディアを待機中…', `${detail} / 広告が届かない場合、そのまま通常キューで進行することがあります`);
      showAdFallback('広告メディアの配信を待っています。このままお待ちください(通常キューで進行する場合もあります)。');
    }
    handleQueueAds(info);
  } else if (info.inQueue || info.queuePosition) {
    setStreamStatus(info.queuePosition ? `待機行列にいます… ${info.queuePosition} 番目` : '待機行列にいます…', detail);
    hideAdOverlay();
  } else if (info.phase === 'paused') {
    setStreamStatus('セッションが一時停止中です', detail);
  } else if (info.phase === 'resuming') {
    setStreamStatus('セッションを再開中…', detail);
  } else {
    setStreamStatus('GPUサーバーを準備中…', detail);
    // 90秒以上 preparing ならヒント表示
    const elapsed = state.stream ? (Date.now() - state.stream.startedAt) / 1000 : 0;
    if (elapsed > 90) {
      setStreamStatus('準備に時間がかかっています…', `${detail} — 無料枠は広告再生が必要な場合があり、混雑時は数分待つことがあります。リージョンを変えて再試行するのも有効です。`);
    }
  }
}

// ---------- 無料枠キュー広告ランタイム(useQueueAdRuntime.ts の簡約移植) ----------

const AD_START_TIMEOUT_MS = 30000; // 再生開始ウォッチドッグ
const AD_STUCK_TIMEOUT_MS = 30000; // 再生停止ウォッチドッグ

/** adMediaFiles[].mediaFileUrl → adUrl → mediaUrl の優先順(getPreferredSessionAdMediaUrl準拠) */
function getAdMediaUrl(ad) {
  return ad?.adMediaFiles?.find((f) => f?.mediaFileUrl)?.mediaFileUrl ?? ad?.adUrl ?? ad?.mediaUrl ?? null;
}

function getPlayableAds(info) {
  return (info.adState?.sessionAds ?? []).filter((ad) => ad?.adId && getAdMediaUrl(ad));
}

function showAdFallback(text) {
  $('ad-overlay').classList.remove('hidden');
  $('ad-video').classList.add('hidden');
  $('ad-fallback').classList.remove('hidden');
  $('ad-fallback-text').textContent = text;
  $('ad-play-btn').classList.add('hidden');
}

function hideAdOverlay() {
  $('ad-overlay').classList.add('hidden');
  $('ad-fallback').classList.add('hidden');
  $('ad-play-btn').classList.add('hidden');
  const video = $('ad-video');
  video.classList.add('hidden');
  video.pause();
  video.removeAttribute('src');
  video.load();
  clearAdWatchdogs();
  state.adRuntime = null;
}

function clearAdWatchdogs() {
  const runtime = state.adRuntime;
  if (!runtime) return;
  if (runtime.startWatchdog) clearTimeout(runtime.startWatchdog);
  if (runtime.stuckWatchdog) clearInterval(runtime.stuckWatchdog);
  runtime.startWatchdog = null;
  runtime.stuckWatchdog = null;
}

function handleQueueAds(info) {
  const ads = getPlayableAds(info);
  if (ads.length === 0) return; // フォールバック表示は updateSessionUi 側
  const runtime = state.adRuntime;
  const finishedIds = runtime?.finishedIds ?? new Set();
  const pending = ads.filter((ad) => !finishedIds.has(ad.adId));
  if (pending.length === 0) return; // 全広告視聴済み → GPU割り当て待ち
  const ad = pending[0];
  // 同じ広告を再生中(finish/cancel未報告)なら何もしない
  if (runtime?.adId === ad.adId && !runtime.reportedFinish) return;
  startAdPlayback(ad, ads.indexOf(ad), ads.length);
}

async function startAdPlayback(ad, index, total) {
  clearAdWatchdogs();
  const previousFinished = state.adRuntime?.finishedIds ?? new Set();
  state.adRuntime = {
    adId: ad.adId,
    index,
    lastAction: null,
    startedAtMs: null,
    wasPaused: false,
    reportedFinish: false,
    startWatchdog: null,
    stuckWatchdog: null,
    lastProgressTs: Date.now(),
    finishedIds: previousFinished,
  };
  const runtime = state.adRuntime;
  const overlay = $('ad-overlay');
  const video = $('ad-video');
  const playBtn = $('ad-play-btn');
  const statusEl = $('ad-status');
  overlay.classList.remove('hidden');
  $('ad-fallback').classList.add('hidden');
  $('stream-status-card').classList.add('hidden');
  video.classList.remove('hidden');
  playBtn.classList.add('hidden');
  statusEl.textContent = `広告 ${index + 1}/${total} を読み込み中… (広告を再生するとキューが進行します)`;
  streamLog(`ad: loading ${ad.adId} (${getAdMediaUrl(ad)})`);

  const onPlaying = () => {
    if (runtime.reportedFinish) return;
    if (!runtime.startedAtMs) {
      runtime.startedAtMs = Date.now();
      reportAdAction('start', ad);
      statusEl.textContent = `広告 ${index + 1}/${total} を再生中… (最後まで視聴するとセッションが進みます)`;
    } else if (runtime.lastAction === 'pause') {
      reportAdAction('resume', ad);
    }
    runtime.lastProgressTs = Date.now();
  };
  const onPause = () => {
    if (runtime.reportedFinish || !runtime.startedAtMs) return;
    if (runtime.lastAction === 'start' || runtime.lastAction === 'resume') {
      runtime.wasPaused = true;
      reportAdAction('pause', ad);
    }
  };
  const onTimeUpdate = () => { runtime.lastProgressTs = Date.now(); };
  const onEnded = () => {
    if (runtime.reportedFinish) return;
    runtime.reportedFinish = true;
    runtime.finishedIds.add(ad.adId);
    clearAdWatchdogs();
    const watchedTimeInMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
    reportAdAction('finish', ad, { watchedTimeInMs });
    statusEl.textContent = '広告視聴完了を報告しました。キューの進行を待っています…';
    streamLog(`ad: finished ${ad.adId} (watched ${watchedTimeInMs}ms)`);
    video.pause();
    video.classList.add('hidden');
  };
  const onError = () => {
    if (runtime.reportedFinish) return;
    clearAdWatchdogs();
    streamLog(`ad: media error ${ad.adId}`);
    if (state.adRuntime) { state.adRuntime.reportedFinish = true; state.adRuntime.finishedIds.add(ad.adId); }
    reportAdAction('cancel', ad, { cancelReason: 'error', errorInfo: 'Error loading url' });
    statusEl.textContent = '広告の読み込みに失敗したためスキップを報告しました。';
    video.classList.add('hidden');
  };

  video.onplaying = onPlaying;
  video.onpause = onPause;
  video.ontimeupdate = onTimeUpdate;
  video.onended = onEnded;
  video.onerror = onError;
  video.src = getAdMediaUrl(ad);

  // 自動再生(音声あり→ミュート→手動ボタン)
  const tryPlay = async (muted) => {
    video.muted = muted;
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  };
  if (!(await tryPlay(false)) && !(await tryPlay(true))) {
    playBtn.classList.remove('hidden');
    statusEl.textContent = 'ブラウザが自動再生をブロックしました。ボタンを押して広告を開始してください。';
    playBtn.onclick = async () => {
      playBtn.classList.add('hidden');
      if (!(await tryPlay(false))) await tryPlay(true);
    };
  }

  // ウォッチドッグ: 30秒以内に再生開始しなければ cancel 報告('Ad play timeout')
  runtime.startWatchdog = setTimeout(() => {
    const rt = state.adRuntime;
    if (!rt || rt.adId !== ad.adId || rt.startedAtMs || rt.reportedFinish) return;
    streamLog(`ad: start timeout ${ad.adId}`);
    if (state.adRuntime) { state.adRuntime.reportedFinish = true; state.adRuntime.finishedIds.add(ad.adId); }
    reportAdAction('cancel', ad, { cancelReason: 'error', errorInfo: 'Ad play timeout' });
    statusEl.textContent = '広告が開始しなかったためスキップを報告しました。';
    video.classList.add('hidden');
  }, AD_START_TIMEOUT_MS);
  // ウォッチドッグ: 再生中に30秒進まなければ cancel 報告('Ad video is stuck')
  runtime.stuckWatchdog = setInterval(() => {
    const rt = state.adRuntime;
    if (!rt || rt.adId !== ad.adId || !rt.startedAtMs || rt.reportedFinish) return;
    if (Date.now() - rt.lastProgressTs > AD_STUCK_TIMEOUT_MS) {
      streamLog(`ad: stuck ${ad.adId}`);
    if (state.adRuntime) { state.adRuntime.reportedFinish = true; state.adRuntime.finishedIds.add(ad.adId); }
      reportAdAction('cancel', ad, { cancelReason: 'error', errorInfo: 'Ad video is stuck' });
      statusEl.textContent = '広告が停止したためスキップを報告しました。';
      video.classList.add('hidden');
    }
  }, 1000);
}

/** 広告アクションを報告(PUT action:6)。応答のセッション状態を即座に反映 */
async function reportAdAction(action, ad, extra = {}) {
  const runtime = state.adRuntime;
  if (runtime) runtime.lastAction = action;
  let pausedTimeInMs = 0;
  if (runtime?.startedAtMs && runtime.wasPaused) {
    const adLengthMs = Number(ad?.adLengthInSeconds) > 0 ? ad.adLengthInSeconds * 1000 : (ad?.durationMs ?? 0);
    const elapsed = Date.now() - runtime.startedAtMs;
    if (adLengthMs > 0 && elapsed > adLengthMs) pausedTimeInMs = Math.round(elapsed - adLengthMs);
  }
  const body = {
    action,
    adId: ad.adId,
    clientTimestamp: Math.floor(Date.now() / 1000),
    pausedTimeInMs,
    ...extra,
  };
  if (extra.watchedTimeInMs === undefined && (action === 'finish' || action === 'cancel')) {
    body.watchedTimeInMs = 0;
  }
  streamLog(`ad: report ${action} ${ad.adId}`);
  try {
    const { session: info } = await api('/api/session/ad', { method: 'POST', body: JSON.stringify(body) });
    if (state.stream) {
      state.stream.sessionInfo = info;
      updateSessionUi(info);
      // 広告完了で即readyになる場合がある
      if (info.readyForConnect && info.signalingUrl && !state.stream.gfnStream) {
        if (state.stream.pollTimer) { clearTimeout(state.stream.pollTimer); state.stream.pollTimer = null; }
        hideAdOverlay();
        await beginStreaming(info);
      }
    }
  } catch (error) {
    streamLog(`ad: report failed (${error.message})`);
  }
}

async function beginStreaming(info) {
  const stream = state.stream;
  const settings = collectLaunchSettings();
  hideAdOverlay();
  $('stream-status-card').classList.remove('hidden');
  setStreamStatus('WebRTCシグナリング接続中…', info.signalingUrl);
  const signaling = new NvstSignalingClient(info.sessionId, { resolution: settings.resolution });
  const gfnStream = new GfnStream({
    videoEl: $('stream-video'),
    session: info,
    settings: {
      resolution: settings.resolution,
      fps: settings.fps,
      maxBitrateKbps: settings.maxBitrateMbps * 1000,
      colorQuality: '8bit_420',
    },
    signaling,
    callbacks: {
      onLog: streamLog,
      onState: (connectionState) => {
        streamLog(`PeerConnection: ${connectionState}`);
        if (connectionState === 'connected') setStreamStatus('接続完了。映像を待機中…');
      },
      onStats: (stats) => {
        const el = $('stream-stats');
        el.classList.remove('hidden');
        el.textContent = [
          stats.connectionState,
          stats.codec,
          stats.resolution,
          stats.fps != null ? `${Math.round(stats.fps)} fps` : null,
          stats.bitrateKbps != null ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps` : null,
          stats.rttMs != null ? `RTT ${stats.rttMs}ms` : null,
        ].filter(Boolean).join(' · ');
      },
      onError: (message) => {
        streamLog(`ERROR: ${message}`);
        setStreamStatus('ストリームエラー', message);
        $('stream-status-card').classList.remove('hidden');
      },
    },
  });
  stream.signaling = signaling;
  stream.gfnStream = gfnStream;
  $('stream-video').addEventListener('playing', () => {
    $('stream-status-card').classList.add('hidden');
    const elapsed = Math.round((Date.now() - stream.startedAt) / 1000);
    streamLog(`映像再生開始(起動から${elapsed}秒)`);
  }, { once: true });
  try {
    await gfnStream.start();
    setStreamStatus('サーバーのSDPオファーを待機中…', 'シグナリング接続済み');
  } catch (error) {
    setStreamStatus('ストリーミング開始に失敗', error.message);
  }
}

async function stopStream({ silent = false } = {}) {
  const stream = state.stream;
  state.stream = null;
  if (stream?.pollTimer) clearTimeout(stream.pollTimer);
  try { stream?.gfnStream?.dispose(); } catch { /* ignore */ }
  if (!silent && state.session) {
    try {
      await api('/api/session/stop', { method: 'POST' });
    } catch (error) {
      if (!silent) showToast(`セッション停止: ${error.message}`);
    }
  } else if (silent && state.session) {
    api('/api/session/stop', { method: 'POST' }).catch(() => {});
  }
}

async function exitStreamView() {
  hideAdOverlay();
  await stopStream();
  const stopBtn = $('stream-cancel-btn');
  stopBtn.textContent = 'キャンセル';
  stopBtn.onclick = null;
  stopBtn.disabled = false;
  $('stream-video').srcObject = null;
  showView('library');
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

  // 起動モーダル
  $('region-ping-btn').addEventListener('click', measureRegionLatency);
  $('launch-form').addEventListener('submit', (event) => {
    if (event.submitter?.value === 'launch') {
      event.preventDefault();
      $('launch-modal').close();
      launchGame();
    }
  });
  // ストリームビュー
  $('stream-stop-btn').addEventListener('click', exitStreamView);
  $('stream-cancel-btn').addEventListener('click', async () => {
    if ($('stream-cancel-btn').onclick) {
      await $('stream-cancel-btn').onclick();
      return;
    }
    await exitStreamView();
  });
  $('stream-fullscreen-btn').addEventListener('click', () => {
    const shell = document.querySelector('.stream-shell');
    if (document.fullscreenElement) document.exitFullscreen();
    else shell.requestFullscreen?.();
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
