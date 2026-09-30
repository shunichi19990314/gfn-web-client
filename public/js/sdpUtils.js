// SDPユーティリティ — OpenNOW v0.5.5 (MIT) renderer/src/platforms/gfn/sdp/{answer,ice}.ts の移植
// 公式 play.geforcenow.com のWebクライアント挙動に合わせる

export const PARTIALLY_RELIABLE_GAMEPAD_MASK_ALL = (1 << 4) - 1; // GAMEPAD_MAX_CONTROLLERS=4
export const PARTIALLY_RELIABLE_HID_DEVICE_MASK_ALL = 0xffffffff;

/** answer SDPに b=AS(ビットレート上限)と opus stereo=1 を注入(公式Webクライアント準拠) */
export function mungeAnswerSdp(sdp, maxBitrateKbps) {
  const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result.push(line);
    if (line.startsWith('m=video') || line.startsWith('m=audio')) {
      const bitrateForSection = line.startsWith('m=video') ? maxBitrateKbps : 128;
      const nextLine = lines[i + 1] ?? '';
      if (!nextLine.startsWith('b=')) {
        result.push(`b=AS:${bitrateForSection}`);
      }
    }
    if (line.startsWith('a=fmtp:') && line.includes('minptime=') && !line.includes('stereo=1')) {
      result[result.length - 1] = `${line};stereo=1`;
    }
  }
  return result.join(lineEnding);
}

/** ダッシュ区切りホスト名をIPに変換: "80-250-97-40.cloudmatchbeta..." → "80.250.97.40" */
export function extractPublicIp(hostOrIp) {
  if (!hostOrIp) return null;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostOrIp)) return hostOrIp;
  const firstLabel = hostOrIp.split('.')[0] ?? '';
  const parts = firstLabel.split('-');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) return parts.join('.');
  return null;
}

/** offer SDP内の 0.0.0.0 ICE候補を実サーバーIPに置換(公式Webクライアント準拠: c=行は触らない)。
 *  `a=candidate:` 行に加え、`a=` 無しの bare `candidate:` 行にも対応(2026-09実測のoffer形式対策) */
export function fixServerIp(sdp, serverIp) {
  const ip = extractPublicIp(serverIp);
  if (!ip) return sdp;
  return sdp.replace(/((?:^|\r?\n)(?:a=)?candidate:\S+\s+\d+\s+\w+\s+\d+\s+)0\.0\.0\.0(\s+)/g, `$1${ip}$2`);
}

function normalizeWebRtcMediaConnectionInfo(mediaConnectionInfo) {
  if (!mediaConnectionInfo) return null;
  if (mediaConnectionInfo.usage !== 2 && mediaConnectionInfo.usage !== 17) return null;
  const ip = String(mediaConnectionInfo.ip ?? '').trim();
  const port = Math.round(Number(mediaConnectionInfo.port));
  if (!ip || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { ip, port };
}

export function rewriteIceCandidateEndpoint(candidate, mediaConnectionInfo) {
  const endpoint = normalizeWebRtcMediaConnectionInfo(mediaConnectionInfo);
  if (!endpoint) return { candidate, rewritten: false };
  const match = candidate.match(
    /^(a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+|candidate:\S+\s+\d+\s+\S+\s+\d+\s+)(\S+)(\s+)(\d+)(?=\s|$)/,
  );
  if (!match) return { candidate, rewritten: false };
  const [, prefix = '', oldIp = '', separator = ' ', oldPort = ''] = match;
  if (oldIp === endpoint.ip && Number.parseInt(oldPort, 10) === endpoint.port) {
    return { candidate, rewritten: false };
  }
  return { candidate: candidate.replace(match[0], `${prefix}${endpoint.ip}${separator}${endpoint.port}`), rewritten: true };
}

export function rewriteSdpIceCandidateEndpoints(sdp, mediaConnectionInfo) {
  if (!normalizeWebRtcMediaConnectionInfo(mediaConnectionInfo)) return { sdp, replacements: 0 };
  const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n';
  let replacements = 0;
  const rewritten = sdp.split(/\r?\n/).map((line) => {
    if (!line.startsWith('a=candidate:')) return line;
    const result = rewriteIceCandidateEndpoint(line, mediaConnectionInfo);
    if (result.rewritten) replacements += 1;
    return result.candidate;
  });
  return { sdp: rewritten.join(lineEnding), replacements };
}

/** ローカルSDPからICE資格情報を抽出(nvstSdpに埋め込む) */
export function extractIceCredentials(sdp) {
  const find = (prefix) => sdp.split(/\r?\n/).find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
  return {
    ufrag: find('a=ice-ufrag:'),
    pwd: find('a=ice-pwd:'),
    fingerprint: find('a=fingerprint:sha-256 '),
  };
}

// ---- サーバーofferからのRI(入力)能力パース — webrtcClient.ts:186-236 ----

export function parsePartialReliableThresholdMs(sdp) {
  const match = sdp.match(/a=ri\.partialReliableThresholdMs:(\d+)/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(5000, parsed));
}

export function parseRiIntegerAttribute(sdp, attribute, fallback) {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sdp.match(new RegExp(`a=${escaped}:([^\\r\\n]+)`, 'i'));
  const raw = match?.[1]?.trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  const parsed = normalized.startsWith('0x')
    ? Number.parseInt(normalized.slice(2), 16)
    : Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseRiInputCapabilities(sdp) {
  return {
    partialReliableThresholdMs: parsePartialReliableThresholdMs(sdp),
    hidDeviceMask: parseRiIntegerAttribute(sdp, 'ri.hidDeviceMask', PARTIALLY_RELIABLE_HID_DEVICE_MASK_ALL),
    enablePartiallyReliableTransferGamepad: parseRiIntegerAttribute(
      sdp, 'ri.enablePartiallyReliableTransferGamepad', PARTIALLY_RELIABLE_GAMEPAD_MASK_ALL,
    ),
    enablePartiallyReliableTransferHid: parseRiIntegerAttribute(
      sdp, 'ri.enablePartiallyReliableTransferHid', PARTIALLY_RELIABLE_HID_DEVICE_MASK_ALL,
    ),
  };
}

/** offer SDPから交渉済みビデオコーデック名を推定 */
export function extractNegotiatedVideoCodec(sdp) {
  // m=video 行の最初のプロファイルID → 対応する a=rtpmap を探す
  const lines = sdp.split(/\r?\n/);
  const videoLine = lines.find((l) => l.startsWith('m=video'));
  if (!videoLine) return null;
  const parts = videoLine.split(/\s+/);
  for (const pt of parts.slice(3)) {
    const rtpmap = lines.find((l) => l.startsWith(`a=rtpmap:${pt} `));
    if (!rtpmap) continue;
    const codec = rtpmap.split(' ')[1]?.split('/')[0]?.toUpperCase();
    if (codec === 'H264') return 'H264';
    if (codec === 'H265') return 'H265';
    if (codec === 'AV1') return 'AV1';
  }
  return null;
}

/** ビデオtransceiverのコーデック優先順位を設定(H264優先)。非対応ブラウザでは何もしない */
export function preferH264(pc) {
  try {
    const caps = RTCRtpReceiver.getCapabilities?.('video');
    if (!caps?.codecs) return false;
    const ordered = [
      ...caps.codecs.filter((c) => /video\/h264/i.test(c.mimeType)),
      ...caps.codecs.filter((c) => !/video\/h264/i.test(c.mimeType)),
    ];
    if (ordered.length === 0) return false;
    let applied = false;
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.receiver?.track?.kind === 'video' && typeof transceiver.setCodecPreferences === 'function') {
        transceiver.setCodecPreferences(ordered);
        applied = true;
      }
    }
    return applied;
  } catch {
    return false;
  }
}


// ---- ice-lite サーバー向け手動候補注入(2026-09 現行インフラ対応) ----
// 現行GFNのWeb offerは a=ice-lite を宣言しながら候補を1つも含まず、
// trickleもしない(実測: remoteCandidates=0 でICEが new のまま → 16秒でサーバー切断)。
// 旧Electron版は mediaConnectionInfo(usage 2/17)からip:portを得て候補を補正していたが、
// 現行応答にはそれが無いため、serverIp + m=行のポートからhost候補を合成する。
// (sdp/ice.ts の extractIceUfragFromOffer コメント「manual ICE candidate injection
//  (ice-lite servers)」が示す技法。ufragはofferと一致させるためusernameFragmentは
//  明示不要 — remoteDescriptionの値が既定で使われる)

/** SDPが ice-lite 宣言を含むか */
export function offerIsIceLite(sdp) {
  return /^a=ice-lite\s*$/m.test(sdp);
}

/** 全 m= 行のポートを抽出(バンドル時は同一値) */
export function extractMLinePorts(sdp) {
  const ports = [];
  for (const line of sdp.split(/\r?\n/)) {
    const match = line.match(/^m=\S+\s+(\d+)/);
    if (match) {
      const port = Number.parseInt(match[1], 10);
      if (Number.isFinite(port) && port > 0 && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}

/** ice-liteサーバーのhost候補を合成 */
export function buildIceLiteHostCandidate(ip, port, foundation = 1) {
  // 一般的なhost候補の優先度(2130706431)で合成。component 1 (rtcp-mux)
  return `candidate:${foundation} 1 udp 2130706431 ${ip} ${port} typ host`;
}
