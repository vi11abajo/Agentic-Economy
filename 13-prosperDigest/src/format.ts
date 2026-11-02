// Number and address formatting shared by events and renderers.

export const num = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 2 : 4 });

export const pct = (n: number | null): string => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(Math.abs(n) >= 10 ? 0 : 1)}%`);

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
};

export const unit = (days: number): string => (days === 7 ? "week" : days === 1 ? "day" : "period");
