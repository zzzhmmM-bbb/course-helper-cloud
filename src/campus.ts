import { bd09ToGcj02, gcj02ToBd09, jitterCoords } from './crypto.js';
import type { CourseLocationPreset } from './types.js';

interface CampusLandmark {
  keywords: string[];
  address: string;
  /** Standard GCJ-02 coordinates at ZCST (珠海科技学院) */
  gcjLat: number;
  gcjLng: number;
}

/**
 * 珠海科技学院（珠科）主要教学区与教学楼内置参考坐标（GCJ-02）。
 * 用于当老师未下发定位中心点且用户也未手动选点时的零配置自动兜底。
 */
const ZCST_LANDMARKS: readonly CampusLandmark[] = [
  {
    keywords: ['明德楼', '明德'],
    address: '珠海科技学院明德楼',
    gcjLat: 22.04935,
    gcjLng: 113.40065,
  },
  {
    keywords: ['笃行楼', '笃行'],
    address: '珠海科技学院笃行楼',
    gcjLat: 22.05012,
    gcjLng: 113.39995,
  },
  {
    keywords: ['博雅楼', '博雅'],
    address: '珠海科技学院博雅楼',
    gcjLat: 22.04878,
    gcjLng: 113.40145,
  },
  {
    keywords: ['国学院', '国学'],
    address: '珠海科技学院国学院',
    gcjLat: 22.05105,
    gcjLng: 113.40182,
  },
  {
    keywords: ['致用楼', '致用'],
    address: '珠海科技学院致用楼',
    gcjLat: 22.04845,
    gcjLng: 113.39942,
  },
  {
    keywords: ['实验楼', '实验'],
    address: '珠海科技学院实验楼',
    gcjLat: 22.04795,
    gcjLng: 113.40088,
  },
  {
    keywords: ['图书馆'],
    address: '珠海科技学院图书馆',
    gcjLat: 22.04968,
    gcjLng: 113.40118,
  },
  {
    keywords: ['一教', '第一教学楼'],
    address: '珠海科技学院第一教学楼',
    gcjLat: 22.04952,
    gcjLng: 113.40025,
  },
  {
    keywords: ['二教', '第二教学楼'],
    address: '珠海科技学院第二教学楼',
    gcjLat: 22.04912,
    gcjLng: 113.40095,
  },
  {
    keywords: ['三教', '第三教学楼'],
    address: '珠海科技学院第三教学楼',
    gcjLat: 22.04868,
    gcjLng: 113.40038,
  },
  {
    keywords: ['四教', '第四教学楼'],
    address: '珠海科技学院第四教学楼',
    gcjLat: 22.04825,
    gcjLng: 113.40122,
  },
  {
    keywords: ['体育馆', '田径场', '操场', '篮球场'],
    address: '珠海科技学院体育运动区',
    gcjLat: 22.05165,
    gcjLng: 113.40045,
  },
];

const ZCST_DEFAULT_CENTER = {
  address: '广东省珠海市金湾区珠海科技学院',
  gcjLat: 22.0495,
  gcjLng: 113.4008,
};

export interface ResolvedLocation {
  latitude: number;
  longitude: number;
  address: string;
  source: 'preset' | 'teacher_center' | 'campus_fallback';
}

export function matchZcstLandmark(classroom?: string): {
  gcjLat: number;
  gcjLng: number;
  address: string;
} {
  const room = (classroom ?? '').trim();
  if (room) {
    for (const item of ZCST_LANDMARKS) {
      if (item.keywords.some((kw) => room.includes(kw))) {
        return {
          gcjLat: item.gcjLat,
          gcjLng: item.gcjLng,
          address: `${item.address} ${room}`.trim(),
        };
      }
    }
  }
  return {
    gcjLat: ZCST_DEFAULT_CENTER.gcjLat,
    gcjLng: ZCST_DEFAULT_CENTER.gcjLng,
    address: room ? `珠海科技学院 ${room}` : ZCST_DEFAULT_CENTER.address,
  };
}

/**
 * 统一解析定位签到坐标（傻瓜式免配置优先级）：
 * 1. 用户曾为该课程手动预设的坐标（自动按目标坐标系转换）
 * 2. 老师发起定位签到时接口返回的中心点坐标 + 4~14 米自然随机微偏
 * 3. 课表教室名自动匹配的内置珠科教学楼坐标 + 微偏
 */
export function resolveLocationForSignIn(params: {
  targetCoord: 'gcj02' | 'bd09';
  preset?: CourseLocationPreset | null;
  teacherLat?: number | null;
  teacherLng?: number | null;
  teacherAddress?: string | null;
  teacherCoord?: 'gcj02' | 'bd09';
  classroom?: string;
}): ResolvedLocation {
  const {
    targetCoord,
    preset,
    teacherLat,
    teacherLng,
    teacherAddress,
    teacherCoord = targetCoord,
    classroom,
  } = params;

  const convert = (
    lat: number,
    lng: number,
    from: 'gcj02' | 'bd09'
  ): { latitude: number; longitude: number } => {
    if (from === targetCoord) return { latitude: lat, longitude: lng };
    return from === 'bd09' ? bd09ToGcj02(lat, lng) : gcj02ToBd09(lat, lng);
  };

  if (
    preset &&
    Number.isFinite(preset.latitude) &&
    Number.isFinite(preset.longitude)
  ) {
    const converted = convert(
      preset.latitude,
      preset.longitude,
      preset.coordType ?? targetCoord
    );
    const jittered = jitterCoords(converted.latitude, converted.longitude, 2, 8);
    return {
      latitude: jittered.latitude,
      longitude: jittered.longitude,
      address: preset.address || classroom || ZCST_DEFAULT_CENTER.address,
      source: 'preset',
    };
  }

  if (
    typeof teacherLat === 'number' &&
    typeof teacherLng === 'number' &&
    Number.isFinite(teacherLat) &&
    Number.isFinite(teacherLng) &&
    Math.abs(teacherLat) > 0.1 &&
    Math.abs(teacherLng) > 0.1
  ) {
    const converted = convert(teacherLat, teacherLng, teacherCoord);
    const jittered = jitterCoords(converted.latitude, converted.longitude, 4, 14);
    return {
      latitude: jittered.latitude,
      longitude: jittered.longitude,
      address:
        (teacherAddress ?? '').trim() ||
        (classroom ?? '').trim() ||
        ZCST_DEFAULT_CENTER.address,
      source: 'teacher_center',
    };
  }

  const fallback = matchZcstLandmark(classroom);
  const converted = convert(fallback.gcjLat, fallback.gcjLng, 'gcj02');
  const jittered = jitterCoords(converted.latitude, converted.longitude, 4, 15);
  return {
    latitude: jittered.latitude,
    longitude: jittered.longitude,
    address: fallback.address,
    source: 'campus_fallback',
  };
}
