import { createPublicClient, fallback, http, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { bsc } from "viem/chains";
import { config } from "../config.js";

// Chain-native DEX signals, read DIRECTLY from the PancakeSwap V2 pair via RPC —
// ground truth, not a noisy aggregate API. Two signals:
//  - liquidityUsd: a SAFETY GATE (refuse thin pools — slippage/rug risk).
//  - dexImbalance / walletFlowUsd: recent buy-vs-sell pressure from Swap events
//    (WBNB-in = someone buying the token; WBNB-out = selling).

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PANCAKE_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
// Swap-event lookback. Public RPCs cap getLogs ranges aggressively; a paid RPC
// (live week) handles larger windows. Configurable; default modest.
const FLOW_BLOCKS = BigInt(Number(process.env.PLIMSOLL_FLOW_BLOCKS ?? 500));

const FACTORY_ABI = parseAbi(["function getPair(address,address) view returns (address)"]);
const PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
]);
const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);

export interface ChainSignals {
  liquidityUsd?: number;
  dexImbalance?: number; // (buy - sell) / (buy + sell), in [-1, 1]
  walletFlowUsd?: number; // net USD into the token over the window
  swapCount?: number; // Swap events in the FLOW_BLOCKS window — raw trade count
}

/** Pure: USD value of a token/WBNB pool ≈ 2 × WBNB-side reserve × BNB price. */
export function computeLiquidityUsd(wbnbReserveRaw: bigint, bnbPriceUsd: number): number {
  return (Number(wbnbReserveRaw) / 1e18) * bnbPriceUsd * 2;
}

/** Pure: aggregate Swap WBNB in/out into imbalance + net USD flow, plus the raw
 *  swap count. The count is reported even when there's no net WBNB flow — zero
 *  flow across 40 swaps is a real (and different) signal from silence. */
export function computeFlow(
  events: { wbnbIn: bigint; wbnbOut: bigint }[],
  bnbPriceUsd: number,
): { dexImbalance?: number; walletFlowUsd?: number; swapCount: number } {
  let buyWbnb = 0n;
  let sellWbnb = 0n;
  for (const e of events) {
    buyWbnb += e.wbnbIn;
    sellWbnb += e.wbnbOut;
  }
  const swapCount = events.length;
  const buyUsd = (Number(buyWbnb) / 1e18) * bnbPriceUsd;
  const sellUsd = (Number(sellWbnb) / 1e18) * bnbPriceUsd;
  const total = buyUsd + sellUsd;
  if (total <= 0) return { swapCount };
  return { dexImbalance: (buyUsd - sellUsd) / total, walletFlowUsd: buyUsd - sellUsd, swapCount };
}

let client: ReturnType<typeof createPublicClient> | undefined;
function rpc() {
  if (!client) {
    // Failover: try the primary RPC, fall to the backup on error so a single
    // provider blip can't blind the agent for the live week. Dedupe so an unset
    // fallback (== primary default) doesn't add a redundant identical endpoint.
    const urls = [...new Set([config.bsc.rpcUrl, config.bsc.rpcFallbackUrl].filter(Boolean))];
    client = createPublicClient({ chain: bsc, transport: fallback(urls.map((u) => http(u))) });
  }
  return client;
}

/** On-chain DEX signals for a token's WBNB pair. Fields are independently
 *  best-effort: liquidity may resolve while flow (getLogs) fails on a public RPC. */
export async function fetchChainSignals(
  tokenAddress: string,
  bnbPriceUsd: number,
): Promise<ChainSignals> {
  if (!tokenAddress.startsWith("0x") || tokenAddress.toLowerCase() === WBNB.toLowerCase()) return {};
  if (!Number.isFinite(bnbPriceUsd) || bnbPriceUsd <= 0) return {};
  try {
    const token = tokenAddress as `0x${string}`;
    const pair = (await rpc().readContract({
      address: PANCAKE_V2_FACTORY,
      abi: FACTORY_ABI,
      functionName: "getPair",
      args: [token, WBNB],
    })) as `0x${string}`;
    if (!pair || pair === zeroAddress) return {};

    const [reserves, token0] = await Promise.all([
      rpc().readContract({ address: pair, abi: PAIR_ABI, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, number]>,
      rpc().readContract({ address: pair, abi: PAIR_ABI, functionName: "token0" }) as Promise<`0x${string}`>,
    ]);
    const wbnbIsToken0 = token0.toLowerCase() === WBNB.toLowerCase();
    const out: ChainSignals = {
      liquidityUsd: computeLiquidityUsd(wbnbIsToken0 ? reserves[0] : reserves[1], bnbPriceUsd),
    };

    // Flow from recent Swap events (best-effort — public RPCs may rate/range-limit getLogs).
    try {
      const tip = await rpc().getBlockNumber();
      const logs = await rpc().getLogs({
        address: pair,
        event: SWAP_EVENT,
        fromBlock: tip > FLOW_BLOCKS ? tip - FLOW_BLOCKS : 0n,
        toBlock: tip,
      });
      const events = logs.map((l) => {
        const a = l.args as { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint };
        return wbnbIsToken0
          ? { wbnbIn: a.amount0In, wbnbOut: a.amount0Out }
          : { wbnbIn: a.amount1In, wbnbOut: a.amount1Out };
      });
      Object.assign(out, computeFlow(events, bnbPriceUsd));
    } catch {
      /* flow unavailable — keep liquidity */
    }
    return out;
  } catch {
    return {};
  }
}
