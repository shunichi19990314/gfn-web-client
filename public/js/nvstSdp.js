// buildNvstSdp — OpenNOW v0.5.5 (MIT) renderer/src/platforms/gfn/sdp/nvstOffer.ts の移植
// WEB(Chromium WebRTC)トランスポート向け。公式 play.geforcenow.com のSDPと
// バイト単位で整合させられた属性セット(コメントは原文の知見を保持)。
import {
  PARTIALLY_RELIABLE_GAMEPAD_MASK_ALL,
  PARTIALLY_RELIABLE_HID_DEVICE_MASK_ALL,
} from './sdpUtils.js';

// 公式Webクライアントの240FPSプロファイルに合わせる
const ENABLE_240_FPS_SPLIT_ENCODE = true;
const ENABLE_DYNAMIC_SPLIT_ENCODE_UPDATES = true;
export const OFFICIAL_MIN_BITRATE_KBPS = 4000;
const HIGH_RESOLUTION_PIXEL_COUNT = 2764800; // 2560x1080 / 1920x1440 クラス
const HIGH_BITRATE_PACING_THRESHOLD_KBPS = 42000;

/**
 * @param {object} params {width,height,fps,maxBitrateKbps,partialReliableThresholdMs,codec,
 *   colorQuality,credentials:{ufrag,pwd,fingerprint},hidDeviceMask?,
 *   enablePartiallyReliableTransferGamepad?,enablePartiallyReliableTransferHid?,
 *   dynamicSplitEncodeUpdatesEnabled?}
 */
export function buildNvstSdp(params) {
  const maxBitrate = Math.max(OFFICIAL_MIN_BITRATE_KBPS, Math.floor(params.maxBitrateKbps));
  const startupBitrate = Math.max(OFFICIAL_MIN_BITRATE_KBPS, Math.round(maxBitrate / 4));
  const isHighFps = params.fps >= 90;
  const is90Fps = params.fps === 90;
  const is120Fps = params.fps === 120;
  const is240Fps = params.fps >= 240;
  const isAv1 = params.codec === 'AV1';
  const pixelCount = params.width * params.height;
  const useHighThroughputPacing =
    pixelCount >= HIGH_RESOLUTION_PIXEL_COUNT || maxBitrate >= HIGH_BITRATE_PACING_THRESHOLD_KBPS;
  const supportsHighBitDepth = params.codec === 'H265' || params.codec === 'AV1';
  const bitDepth = supportsHighBitDepth && String(params.colorQuality).startsWith('10bit') ? 10 : 8;
  const hidDeviceMask = params.hidDeviceMask ?? PARTIALLY_RELIABLE_HID_DEVICE_MASK_ALL;
  const enablePartiallyReliableTransferGamepad = params.enablePartiallyReliableTransferGamepad
    ?? PARTIALLY_RELIABLE_GAMEPAD_MASK_ALL;
  const enablePartiallyReliableTransferHid = params.enablePartiallyReliableTransferHid ?? hidDeviceMask;
  const dynamicSplitEncodeUpdatesEnabled = params.dynamicSplitEncodeUpdatesEnabled ?? ENABLE_DYNAMIC_SPLIT_ENCODE_UPDATES;

  const lines = [
    'v=0',
    'o=SdpTest test_id_13 14 IN IPv4 127.0.0.1',
    's=-',
    't=0 0',
    `a=general.icePassword:${params.credentials.pwd}`,
    `a=general.iceUserNameFragment:${params.credentials.ufrag}`,
    `a=general.dtlsFingerprint:${params.credentials.fingerprint}`,
    'm=video 0 RTP/AVP',
    'a=msid:fbc-video-0',
    // 安定したAndroidネイティブ復旧プロファイルに合わせる。大きなFEC/NACKバーストは
    // パケットロス後の輻輳をBWE回復の代わりに増幅してしまう。
    'a=vqos.fec.rateDropWindow:10',
    'a=vqos.fec.minRequiredFecPackets:2',
    'a=vqos.drc.minRequiredBitrateCheckEnabled:1',
    'a=vqos.fec.repairMinPercent:5',
    'a=vqos.fec.repairPercent:5',
    'a=vqos.fec.repairMaxPercent:35',
    // 公式Webクライアント既定 dynamicStreamingMode=3(DRC+DFC+ビットレートエンベロープ)
    'a=vqos.dynamicStreamingMode:3',
    // 公式Webクライアントは常に vqos.bllFec.enable:0 を送る。
    // drc.enable / dfc.enable は60FPSセッションでは送られない(高FPSのみ、下記参照)
    'a=vqos.bllFec.enable:0',
  ];

  if (isHighFps) {
    // 公式Webクライアント dynamicStreamingMode=3 + 高FPS:
    // drc.enable:0, dfc.enable:1, decodeFpsAdjPercent:85, targetDownCooldownMs:250,
    // dfcAlgoVersion 2(120/240)/1(90), minTargetFps 100(120/240)/60(90),
    // resControl.dfc.useClientFpsPerf:0, dfc.adjustResAndFps:1
    lines.push(
      'a=vqos.drc.enable:0',
      'a=vqos.dfc.enable:1',
      'a=vqos.dfc.decodeFpsAdjPercent:85',
      'a=vqos.dfc.targetDownCooldownMs:250',
      `a=vqos.dfc.dfcAlgoVersion:${is120Fps || is240Fps ? 2 : 1}`,
      `a=vqos.dfc.minTargetFps:${is90Fps ? 60 : 100}`,
      'a=vqos.resControl.dfc.useClientFpsPerf:0',
      'a=vqos.dfc.adjustResAndFps:1',
    );
  } else {
    // 公式Webクライアント 60FPS + dynamicStreamingMode=3: drc.enable:1 のみ
    lines.push('a=vqos.drc.enable:1');
  }

  // ビデオエンコーダ設定
  lines.push(
    'a=video.dx9EnableNv12:1',
    'a=video.dx9EnableHdr:1',
    'a=vqos.qpg.enable:1',
    'a=vqos.resControl.qp.qpg.featureSetting:7',
    // 注意: 公式Webクライアントは video.framePacing.* / video.adaptiveQuantization.* を送らない
    // (それらはネイティブクライアントダンプ由来のフォーク独自追加だった。バイト整合のため削除)
    'a=bwe.useOwdCongestionControl:1',
    'a=video.enableRtpNack:1',
    'a=vqos.bw.txRxLag.minFeedbackTxDeltaMs:200',
    'a=vqos.drc.bitrateIirFilterFactor:18',
    'a=video.packetSize:1140',
    // 公式Webクライアントは packetPacing.minNumPacketsPerGroup のみを送る
    'a=packetPacing.minNumPacketsPerGroup:15',
  );

  // 高FPS最適化
  if (isHighFps) {
    lines.push(
      'a=bwe.iirFilterFactor:8',
      'a=video.encoderFeatureSetting:47',
      'a=video.encoderPreset:6',
      'a=vqos.resControl.cpmRtc.badNwSkipFramesCount:600',
      `a=vqos.resControl.cpmRtc.decodeTimeThresholdMs:${is90Fps ? 11 : 9}`,
      `a=video.fbcDynamicFpsGrabTimeoutMs:${is90Fps ? 9 : is120Fps ? 6 : 18}`,
      `a=vqos.resControl.cpmRtc.serverResolutionUpdateCoolDownCount:${is120Fps ? 6000 : 12000}`,
      ...(is120Fps || is240Fps ? ['a=video.fakeEncodeFps:120'] : []),
    );
  }

  // 240FPS最適化
  if (is240Fps) {
    lines.push('a=video.enableNextCaptureMode:1', 'a=vqos.maxStreamFpsEstimate:240');
    if (ENABLE_240_FPS_SPLIT_ENCODE) {
      // 公式240FPS DESCRIBE は63ストリップ(旧Webクライアント値3ではない)
      lines.push(
        'a=video.videoSplitEncodeStripsPerFrame:63',
        `a=video.updateSplitEncodeStateDynamically:${dynamicSplitEncodeUpdatesEnabled ? 1 : 0}`,
      );
    }
  }

  // 非フォーカス時の扱い + CPM解像度制御(公式Webクライアント)
  // cpmRtc.featureMask:3(CPM経路有効時=Web既定)。cpmRtc.enable/minResolutionPercent/
  // resolutionChangeHoldonMs は送らない(フォーク独自の固定値はサーバーのCPM解像度制御を
  // 無効化し、dynamicStreamingMode:3 と衝突してBWEを4000kbps床に固定してしまう)
  lines.push(
    'a=vqos.adjustStreamingFpsDuringOutOfFocus:1',
    'a=vqos.resControl.cpmRtc.ignoreOutOfFocusWindowState:1',
    'a=vqos.resControl.perfHistory.rtcIgnoreOutOfFocusWindowState:1',
    'a=vqos.resControl.cpmRtc.featureMask:3',
  );

  // パケットペーシンググループ/遅延 + NACKキュー(公式Nvsc既定)
  lines.push(
    `a=packetPacing.numGroups:${is120Fps ? 3 : 5}`,
    'a=packetPacing.maxDelayUs:1000',
    'a=packetPacing.minNumPacketsFrame:10',
    'a=video.rtpNackQueueLength:1024',
    'a=video.rtpNackQueueMaxPackets:512',
    'a=video.rtpNackMaxPacketCount:25',
  );

  if (useHighThroughputPacing) {
    lines.push('a=vqos.drc.iirFilterFactor:100');
    if (!isAv1) {
      lines.push(
        'a=vqos.drc.qpMaxResThresholdAdj:4',
        'a=vqos.dfc.qpMaxResThresholdAdj:4',
        'a=vqos.grc.qpMaxResThresholdAdj:2',
      );
    }
  }

  // AV1固有のDRC/GRCチューニング(公式クライアントの意図を反映):
  // 解像度ダウングレード前のQP適応を優先させる
  if (isAv1) {
    const av1QpMaxResThresholdAdj = useHighThroughputPacing ? 20 : 0;
    lines.push(
      'a=vqos.drc.minQpHeadroom:20',
      'a=vqos.drc.lowerQpThreshold:100',
      'a=vqos.drc.upperQpThreshold:200',
      'a=vqos.drc.minAdaptiveQpThreshold:180',
      `a=vqos.drc.qpMaxResThresholdAdj:${av1QpMaxResThresholdAdj}`,
      'a=vqos.drc.qpCodecThresholdAdj:0',
      'a=vqos.dfc.minQpHeadroom:20',
      'a=vqos.dfc.qpLowerLimit:100',
      'a=vqos.dfc.qpMaxUpperLimit:200',
      'a=vqos.dfc.qpMinUpperLimit:180',
      `a=vqos.dfc.qpMaxResThresholdAdj:${av1QpMaxResThresholdAdj}`,
      'a=vqos.dfc.qpCodecThresholdAdj:0',
      'a=vqos.grc.minQpHeadroom:20',
      'a=vqos.grc.lowerQpThreshold:100',
      'a=vqos.grc.upperQpThreshold:200',
      'a=vqos.grc.minAdaptiveQpThreshold:180',
      `a=vqos.grc.qpMaxResThresholdAdj:${av1QpMaxResThresholdAdj}`,
      'a=vqos.grc.qpCodecThresholdAdj:0',
      'a=video.minQp:25',
      'a=video.enableAv1RcPrecisionFactor:1',
    );
  }

  // ビューポート、FPS、ビットレート
  lines.push(
    `a=video.clientViewportWd:${params.width}`,
    `a=video.clientViewportHt:${params.height}`,
    // 公式Webクライアントは設定のセッションFPSを送る
    `a=video.maxFPS:${params.fps}`,
    // ビットレート属性は公式GFN Webクライアントを完全ミラー(play.geforcenow.comの
    // バンダルダンプで検証済み): initial = initialPeak = max(4000, max/4)、minimumは4000固定。
    // enableBandwidthEstimation/disableBitrateLimit/peakBitrateKbps 等は送らない
    // (サーバー側スロットリングBWEを起動させ、4000kbps床付近に張り付かせてしまう)
    `a=video.initialBitrateKbps:${startupBitrate}`,
    `a=video.initialPeakBitrateKbps:${startupBitrate}`,
    `a=vqos.bw.maximumBitrateKbps:${maxBitrate}`,
    `a=vqos.bw.minimumBitrateKbps:${OFFICIAL_MIN_BITRATE_KBPS}`,
    // エンコーダ設定 — encoderCscMode はデスクトップWebで常に3(公式は TIZEN ? 2 : 3)
    'a=video.maxNumReferenceFrames:4',
    'a=video.mapRtpTimestampsToFrames:1',
    'a=video.encoderCscMode:3',
    'a=video.encoderHdrCscMode:4',
    `a=video.dynamicRangeMode:${bitDepth === 10 ? 1 : 0}`,
    `a=video.bitDepth:${bitDepth}`,
    // 公式Webクライアントは 10-bit H265 のみ video.minQp:14(8bit H265は送らない。AV1は上で25固定)
    ...(params.codec === 'H265' && bitDepth === 10 ? ['a=video.minQp:14'] : []),
    // サーバー側スケーリングとプリフィルタを無効化(解像度ダウングレード防止)
    // 公式Webクライアントは prefilterParams 一式を送る — mode OFF, model 0, denoise 0, sharpness 0
    `a=video.scalingFeature1:${isAv1 ? 1 : 0}`,
    'a=video.prefilterParams.prefilterMode:0',
    'a=video.prefilterParams.prefilterModel:0',
    'a=video.prefilterParams.denoiseLevel:0',
    'a=video.prefilterParams.sharpnessLevel:0',
    // 音声トラック(サーバーからの受信専用)
    // 注意: 公式Webクライアントは aqos.* / audio.* 属性を一切送らない(バンドルダンプで検証)
    'm=audio 0 RTP/AVP',
    'a=msid:audio',
    // マイクトラック(サーバーへの送信)
    'm=mic 0 RTP/AVP',
    'a=msid:mic',
    'a=rtpmap:0 PCMU/8000',
    // 入力/アプリケーショントラック
    // ri.* の値はサーバーofferからエコー(公式クライアントはDESCRIBE応答からエコーする)
    'm=application 0 RTP/AVP',
    'a=msid:input_1',
    `a=ri.partialReliableThresholdMs:${params.partialReliableThresholdMs}`,
    `a=ri.hidDeviceMask:${hidDeviceMask}`,
    `a=ri.enablePartiallyReliableTransferGamepad:${enablePartiallyReliableTransferGamepad}`,
    `a=ri.enablePartiallyReliableTransferHid:${enablePartiallyReliableTransferHid}`,
    '',
  );

  return lines.join('\n');
}
