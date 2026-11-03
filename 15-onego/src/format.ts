// Token amounts for people: thousands separated, at most six decimals, no trailing zeros.
export function fmt(units: bigint, decimals: number, maxFrac = 6): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const whole = u / 10n ** BigInt(decimals);
  const frac = (u % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}
