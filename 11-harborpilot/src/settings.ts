// Settings the user can change with `config set`.
export interface Settings {
  /** Gas limit = estimate + this %. */
  gas_buffer_pct: number;
  /** The most USDC one deposit may move. */
  max_usdc_per_deposit: number;
  /** A borrow is refused if the loan would be above this share of the collateral's value (the market liquidates at 38.5%). */
  max_ltv: number;
  /** A venue that hasn't answered in this many ms is reported as down. */
  venue_timeout_ms: number;
}

export const DEFAULTS: Settings = { gas_buffer_pct: 20, max_usdc_per_deposit: 100, max_ltv: 0.3, venue_timeout_ms: 25_000 };
