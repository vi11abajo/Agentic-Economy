// The rules `siren init` writes for you. Sizes are about 5,000 PROS (some $2,300 at the November 2026 price), where
// the small fry stops: on 2026-11-14 the 400 USDC / 800 WPROS / 50 PROS lines mostly caught three wallets passing
// $500 around. DODOFeeRouteProxy is DODO's router (that name is what the explorer shows for it).
export const EXAMPLE_RULES = `{
  "pollSeconds": 10,
  "rules": [
    { "name": "usdc-2500", "kind": "transfer", "token": "USDC", "min": 2500 },
    { "name": "wpros-5000", "kind": "transfer", "token": "WPROS", "min": 5000 },
    { "name": "pros-below-45c", "kind": "price", "feed": "PROS/USD", "below": 0.45 },
    { "name": "pros-above-50c", "kind": "price", "feed": "PROS/USD", "above": 0.50 },
    { "name": "dodo-swap-5000-pros", "kind": "call", "label": "DODO swap paid with 5000+ PROS",
      "to": "0xa5ca5fbe34e444f366b373170541ec6902b0f75c", "minValue": 5000 }
  ]
}
`;
