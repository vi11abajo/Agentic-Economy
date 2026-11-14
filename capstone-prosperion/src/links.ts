// Links that open our signing page inside a phone wallet's own browser. Each format was scanned on a real phone
// (prosperion-recon/qr-test.html, cards 8, 10, 12) and opened the page with the wallet injected. Rabby has no QR
// scanner for URLs, so for Rabby the link itself is the way in.
export const SITE = process.env.PROSPERION_SITE ?? "https://prosperion.pharosfdv.xyz";

export function walletLinks(url: string) {
  return {
    okx: `https://web3.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`)}`,
    rabby: `https://go.rabby.io/mobile/?_cmd=open-dapp&dapp=${encodeURIComponent(url)}`,
    metamask: `https://metamask.app.link/dapp/${url.replace(/^https:\/\//, "")}`,
  };
}

/** Push links only ever point at our own sign page, with an id we generated. */
export function requestUrl(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("bad request id");
  return `${SITE}/sign/?r=${id}`;
}
