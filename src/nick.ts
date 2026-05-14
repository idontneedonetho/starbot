export interface NickResult {
  nickname: string;
  valid: boolean;
  error?: string;
}

export function computeNickname(name: string, year: string, make: string, model: string): NickResult {
  const suffix = ` ('${year.slice(-2)} ${make} ${model})`;
  if (suffix.length > 32) {
    return { nickname: '', valid: false, error: 'Vehicle details are too long for a Discord nickname.' };
  }
  const maxNameLen = 32 - suffix.length;
  const truncatedName = name.slice(0, maxNameLen);
  return { nickname: `${truncatedName}${suffix}`, valid: true };
}
