// Picking the blocks we sample oracle prices at. Pharos makes roughly a block a second, but "roughly" isn't
// good enough to annualise a drift, so we only use the block rate to aim and then read each block's real
// timestamp.
import type { Chain } from "./chain.js";

export interface Sample {
  block: number;
  time: number;
}

/** n points spread over the last `days`, oldest first, ending at `head`. */
export async function sampleBlocks(chain: Chain, head: number, days = 7, n = 8): Promise<Sample[]> {
  const probe = Math.max(1, head - 200_000);
  const [tHead, tProbe] = await Promise.all([chain.timestamp(head), chain.timestamp(probe)]);
  const perSecond = (head - probe) / Math.max(1, tHead - tProbe);
  const span = days * 86_400;
  const blocks: number[] = [];
  for (let i = 0; i < n; i++) {
    const back = Math.round(((span * (n - 1 - i)) / (n - 1)) * perSecond);
    blocks.push(Math.max(1, head - back));
  }
  const times = await Promise.all(blocks.map((b) => chain.timestamp(b)));
  return blocks.map((block, i) => ({ block, time: times[i] }));
}
