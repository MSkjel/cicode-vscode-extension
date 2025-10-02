export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
): T {
  let t: NodeJS.Timeout | undefined;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export const log = (...a: any[]) => console.log("[cicode]", ...a);
export const warn = (...a: any[]) => console.warn("[cicode]", ...a);
export const error = (...a: any[]) => console.error("[cicode]", ...a);
