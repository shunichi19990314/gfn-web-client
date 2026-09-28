// アップストリーム(NVIDIA)へのHTTP呼び出しユーティリティ
import { UPSTREAM_TIMEOUT_MS } from './config.js';

export class UpstreamError extends Error {
  /**
   * @param {'network_error'|'upstream_error'|'invalid_params'|'authentication_required'|'graphql_error'} code
   */
  constructor(code, message, { status, payload } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

/** タイムアウト付きfetch + JSONパース。エラーはUpstreamErrorに正規化 */
export async function fetchJson(url, { headers, method = 'GET', body, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
  } catch (error) {
    throw new UpstreamError('network_error', `${url.host ?? url}: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 2000) };
    }
  }
  return { status: response.status, ok: response.ok, payload, headers: response.headers };
}

/** 401/403 → authentication_required に正規化して throw */
export function assertOk(result, context) {
  if (result.ok) return result.payload;
  const detail =
    result.payload && typeof result.payload === 'object'
      ? result.payload.error ?? result.payload.message ?? result.payload.errors?.[0]?.message
      : undefined;
  if (result.status === 401 || result.status === 403) {
    throw new UpstreamError('authentication_required', `${context} (${result.status})${detail ? `: ${detail}` : ''}`, {
      status: result.status,
      payload: result.payload,
    });
  }
  throw new UpstreamError('upstream_error', `${context} (${result.status})${detail ? `: ${detail}` : ''}`, {
    status: result.status,
    payload: result.payload,
  });
}
