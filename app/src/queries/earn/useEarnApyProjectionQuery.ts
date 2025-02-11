import { useAnchorWebapp } from '@anchor-protocol/app-provider/contexts/context';
import { HumanAddr, Rate } from '@libs/types';
import { UseQueryResult } from 'react-query';
import big, { Big } from 'big.js';
import { min, max, abs } from '@libs/big-math';
import { createQueryFn } from '@libs/react-query-utils';
import { ANCHOR_QUERY_KEY } from '@anchor-protocol/app-provider/env';
import { wasmFetch, QueryClient, WasmQuery } from '@libs/query-client';
import { moneyMarket } from '@anchor-protocol/types';
import { terraNativeBalancesQuery } from '@libs/app-fns';
import { useAnchorQuery } from 'queries/useAnchorQuery';
import { useNetwork } from '@anchor-protocol/app-provider';

interface ProjectedEarnApyWasmQuery {
  overseerDynRateState: WasmQuery<
    moneyMarket.overseer.DynRateState,
    moneyMarket.overseer.DynRateStateResponse
  >;
  overseerConfig: WasmQuery<
    moneyMarket.overseer.Config,
    moneyMarket.overseer.ConfigResponse
  >;
}

// the logic is adapted from https://github.com/Anchor-Protocol/money-market-contracts/blob/5d902c3f029eeda6597e54763e4b608a716603a1/contracts/overseer/src/contract.rs#L389
const computeYieldReserveChange = (
  state: moneyMarket.overseer.DynRateStateResponse,
  config: moneyMarket.overseer.ConfigResponse,
  currentBalance: Big,
) => {
  const { dyn_rate_yr_increase_expectation, dyn_rate_maxchange } = config;

  const { prev_yield_reserve: previousBalance } = state;

  let isCurrentYieldReserveHigher = currentBalance.gt(previousBalance);

  const yieldReserveDelta = abs(currentBalance.minus(previousBalance));

  let yieldReserveChange = Big(previousBalance).eq(0)
    ? big(1)
    : yieldReserveDelta.div(previousBalance);

  if (!isCurrentYieldReserveHigher) {
    yieldReserveChange = yieldReserveChange.add(
      dyn_rate_yr_increase_expectation,
    );
  } else if (yieldReserveChange.gt(dyn_rate_yr_increase_expectation)) {
    yieldReserveChange = yieldReserveChange.minus(
      dyn_rate_yr_increase_expectation,
    );
  } else {
    isCurrentYieldReserveHigher = !isCurrentYieldReserveHigher;
  }

  return {
    isHigher: isCurrentYieldReserveHigher,
    change: min(yieldReserveChange, dyn_rate_maxchange),
  };
};

const computeNewRate = (
  config: moneyMarket.overseer.ConfigResponse,
  yr: ReturnType<typeof computeYieldReserveChange>,
  blocksPerYear: number,
) => {
  const { threshold_deposit_rate, dyn_rate_min, dyn_rate_max } = config;

  function clamp(rate: Big) {
    // convert from yearly rate to block rate
    rate = rate.div(blocksPerYear);

    // clamp new rate
    return max(min(rate, dyn_rate_max), dyn_rate_min);
  }

  const currentRate = Big(threshold_deposit_rate).mul(blocksPerYear);

  if (yr.isHigher) {
    return clamp(currentRate.plus(yr.change));
  }

  if (currentRate.gt(yr.change)) {
    return clamp(currentRate.minus(yr.change));
  }

  return clamp(big(0));
};

const earnApyProjectionQuery = async (
  network: string,
  blocksPerYear: number,
  overseerContract: HumanAddr,
  queryClient: QueryClient,
) => {
  if (network === 'mainnet') {
    return undefined;
  }

  const { uUST } = await terraNativeBalancesQuery(
    overseerContract,
    queryClient,
  );

  const { overseerDynRateState, overseerConfig } =
    await wasmFetch<ProjectedEarnApyWasmQuery>({
      ...queryClient,
      id: 'projected-earn-apy',
      wasmQuery: {
        overseerDynRateState: {
          contractAddress: overseerContract,
          query: { dynrate_state: {} },
        },
        overseerConfig: {
          contractAddress: overseerContract,
          query: { config: {} },
        },
      },
    });

  const change = computeYieldReserveChange(
    overseerDynRateState,
    overseerConfig,
    big(uUST),
  );

  const newRate = computeNewRate(overseerConfig, change, blocksPerYear);

  return {
    rate: newRate.mul(blocksPerYear),
    height:
      overseerDynRateState.last_executed_height + overseerConfig.dyn_rate_epoch,
  };
};

const earnApyProjectionQueryFn = createQueryFn(earnApyProjectionQuery);

interface EarnApyProjection {
  height: number;
  rate: Rate<big>;
}

export const useEarnApyProjectionQuery =
  (): UseQueryResult<EarnApyProjection> => {
    const {
      contractAddress,
      queryClient,
      constants: { blocksPerYear },
    } = useAnchorWebapp();

    const { network } = useNetwork();

    return useAnchorQuery(
      [
        ANCHOR_QUERY_KEY.PROJECTED_EARN_APY,
        network.name,
        blocksPerYear,
        contractAddress.moneyMarket.overseer,
        queryClient,
      ],
      earnApyProjectionQueryFn,
      {
        refetchOnMount: false,
        refetchInterval: 1000 * 60 * 5,
        keepPreviousData: true,
      },
    );
  };
