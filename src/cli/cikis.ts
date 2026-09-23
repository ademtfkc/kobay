export const CIKIS = {
  GECTI: 0,
  DUSTU: 1,
  KULLANIM: 2,
  HEDEF_YOK: 3,
  MOTOR: 4,
  YETKI: 5,
} as const;

export type CikisKodu = (typeof CIKIS)[keyof typeof CIKIS];
