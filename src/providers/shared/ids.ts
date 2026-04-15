export function fallbackId(prefix: string, index: number): string {
  return `${prefix}:${index + 1}`;
}
