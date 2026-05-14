export interface NickResult {
  nickname: string;
  valid: boolean;
  error?: string;
}

export function computeNickname(username: string, year: string, model: string): NickResult {
  const yearShort = year.slice(-2);
  const suffix = ` ('${yearShort} ${model})`;
  if (suffix.length > 32) {
    return { nickname: '', valid: false, error: 'Vehicle details are too long for a Discord nickname.' };
  }
  const maxNameLen = 32 - suffix.length;
  const truncatedName = username.slice(0, maxNameLen);
  return { nickname: `${truncatedName}${suffix}`, valid: true };
}
