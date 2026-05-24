export const COLORS = {
  blurple: 0x5865f2,
  amber: 0xf0b132,
  green: 0x248046,
  red: 0xe74c3c,
} as const;

export function dot(a: number[], b: number[]): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i] * b[i];
  return result;
}
