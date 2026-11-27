import crypto from 'node:crypto';
import type { AccountDeviceInfo } from './types.js';

export const CHAOXING_CONSTANTS = {
  schildSalt: 'ipL$TkeiEmfy1gTXb2XHrdLN0a@7c^vu',
  deviceCodeKey: 'QrCbNY@MuK1X8HGw',
  infEncToken: '4faa8662c59590c6f43ae9fe5b002b42',
  infEncKey: 'Z(AfY@XS',
} as const;

export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
  }

  decrypt(payload: string): string {
    if (!payload) return '';
    if (!payload.startsWith('v1:')) {
      return payload;
    }
    const parts = payload.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted payload format');
    }
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString('utf8');
  }
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function md5Hex(text: string): string {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

export function aesEcbEncryptBase64(text: string, keyUtf8: string): string {
  const keyBuf = Buffer.from(keyUtf8, 'utf8');
  const alg =
    keyBuf.length === 16
      ? 'aes-128-ecb'
      : keyBuf.length === 24
        ? 'aes-192-ecb'
        : 'aes-256-ecb';
  const cipher = crypto.createCipheriv(alg, keyBuf, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  return encrypted.toString('base64');
}

export function getUniqueId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function getCxDeviceCode(): string {
  return aesEcbEncryptBase64(
    crypto.randomUUID(),
    CHAOXING_CONSTANTS.deviceCodeKey
  );
}

export function getCxEncParams(
  params: Record<string, string>
): Record<string, string> {
  const encParams: Record<string, string> = {
    _c_0_: getUniqueId(),
    token: CHAOXING_CONSTANTS.infEncToken,
    _time: Date.now().toString(),
  };
  const merged: Record<string, string> = { ...params, ...encParams };
  const queryString = Object.entries(merged)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  encParams.inf_enc = md5Hex(
    `${queryString}&DESKey=${CHAOXING_CONSTANTS.infEncKey}`
  );
  return encParams;
}

export function buildCxUserAgent(uniqueId: string): string {
  const systemHttpAgent =
    'Dalvik/2.1.0 (Linux; U; Android 16; Pixel 9 Pro Build/BP4A.260205.002)';
  const userAgentTemp = `(device:Pixel 9 Pro) Language/zh_CN com.chaoxing.mobile/ChaoXingStudy_3_6.7.4_android_phone_10940_314 (@Kalimdor)_${uniqueId}`;
  const schild = md5Hex(
    `(schild:${CHAOXING_CONSTANTS.schildSalt}) ${userAgentTemp}`
  );
  return `${systemHttpAgent} (schild:${schild}) ${userAgentTemp}`;
}

export function buildCxLocationResultJson(
  deviceInfo: AccountDeviceInfo,
  address: string,
  latitude: number,
  longitude: number
): string {
  const timeStampMS = Date.now().toString();
  const cxcid = typeof deviceInfo.cid === 'string' ? deviceInfo.cid : '';
  const sc = typeof deviceInfo.sc === 'string' ? deviceInfo.sc : '';

  const signConfigMap: Record<string, string> = {
    data: `{"latitude":${latitude},"longitude":${longitude},"address":"${address}"}`,
    cxtime: timeStampMS,
    cxcid,
  };
  const sortedKeys = Object.keys(signConfigMap).sort();
  let raw = '';
  for (const k of sortedKeys) {
    raw += `${k}${signConfigMap[k]}`;
  }
  raw += sc;
  const signToken = md5Hex(raw);

  return JSON.stringify({
    result: 1,
    latitude,
    longitude,
    mockData: { strategy: 0, probability: -1 },
    locType: 161,
    address,
    signConfig: {
      signToken,
      cxcid,
      cxtime: timeStampMS,
    },
  });
}

const X_PI = (Math.PI * 3000.0) / 180.0;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export function bd09ToGcj02(bdLat: number, bdLng: number): GeoPoint {
  const x = bdLng - 0.0065;
  const y = bdLat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return {
    latitude: z * Math.sin(theta),
    longitude: z * Math.cos(theta),
  };
}

export function gcj02ToBd09(gcjLat: number, gcjLng: number): GeoPoint {
  const z =
    Math.sqrt(gcjLng * gcjLng + gcjLat * gcjLat) +
    0.00002 * Math.sin(gcjLat * X_PI);
  const theta =
    Math.atan2(gcjLat, gcjLng) + 0.000003 * Math.cos(gcjLng * X_PI);
  return {
    latitude: z * Math.sin(theta) + 0.006,
    longitude: z * Math.cos(theta) + 0.0065,
  };
}

/**
 * 为签到中心点叠加 4~14 米自然随机偏移，避免与教师中心点完全重合。
 */
export function jitterCoords(
  latitude: number,
  longitude: number,
  minMeters = 4,
  maxMeters = 14
): GeoPoint {
  const distMeters = minMeters + Math.random() * Math.max(0, maxMeters - minMeters);
  const angle = Math.random() * 2 * Math.PI;
  const latRad = (latitude * Math.PI) / 180;
  const deltaLat = (distMeters * Math.cos(angle)) / 111320;
  const deltaLng =
    (distMeters * Math.sin(angle)) / (111320 * Math.max(0.2, Math.cos(latRad)));
  return {
    latitude: Number((latitude + deltaLat).toFixed(6)),
    longitude: Number((longitude + deltaLng).toFixed(6)),
  };
}
