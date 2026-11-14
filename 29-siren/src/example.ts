// The rules `siren init` writes for you. Sizes are picked so a normal hour on Pharos mainnet gives a handful of
// alerts, not a flood. DODOFeeRouteProxy is DODO's router (that name is what the explorer shows for it).
export const EXAMPLE_RULES = `{
  "pollSeconds": 10,
  "rules": [
    { "name": "usdc-400", "kind": "transfer", "token": "USDC", "min": 400 },
    { "name": "wpros-800", "kind": "transfer", "token": "WPROS", "min": 800 },
    { "name": "pros-below-45c", "kind": "price", "feed": "PROS/USD", "below": 0.45 },
    { "name": "pros-above-50c", "kind": "price", "feed": "PROS/USD", "above": 0.50 },
    { "name": "dodo-swap-50-pros", "kind": "call", "label": "DODO swap paid with 50+ PROS",
      "to": "0xa5ca5fbe34e444f366b373170541ec6902b0f75c", "minValue": 50 }
  ]
}
`;
