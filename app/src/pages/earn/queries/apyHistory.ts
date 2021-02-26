import { DateTime, JSDateTime, Ratio } from '@anchor-protocol/notation';
import { createMap, useMap } from '@anchor-protocol/use-map';
import { gql, useQuery } from '@apollo/client';
import { useService } from 'contexts/service';
import { MappedQueryResult } from 'queries/types';
import { useQueryErrorHandler } from 'queries/useQueryErrorHandler';
import { useRefetch } from 'queries/useRefetch';
import { useMemo } from 'react';

export interface RawData {
  apyHistory: {
    Timestamp: DateTime;
    Height: number;
    DepositRate: Ratio<string>;
  }[];
}

export type Data = RawData;

export const dataMap = createMap<RawData, Data>({
  apyHistory: (_, { apyHistory }) => {
    return apyHistory;
  },
});

export interface RawVariables {
  timestampMax: DateTime;
}

export interface Variables {
  timestampMax: JSDateTime;
}

export function mapVariables({ timestampMax }: Variables): RawVariables {
  return {
    timestampMax: Math.floor(timestampMax / 1000) as DateTime,
  };
}

export const query = gql`
  query __apyHistory($timestampMax: Int!) {
    apyHistory: AnchorDepositRateHistory(
      Order: DESC
      Limit: 9
      Timestamp_range: [0, $timestampMax]
    ) {
      Timestamp
      Height
      DepositRate
    }
  }
`;

export function useAPYHistory(): MappedQueryResult<
  RawVariables,
  RawData,
  Data
> {
  const { serviceAvailable } = useService();

  const variables = useMemo(() => {
    return mapVariables({
      //timestampMax: (Date.now() - 1000 * 60 * 60 * 24) as JSDateTime,
      timestampMax: (Date.now() - 1000 * 60 * 30) as JSDateTime,
    });
  }, []);

  const onError = useQueryErrorHandler();

  const { data: _data, refetch: _refetch, error, ...result } = useQuery<
    RawData,
    RawVariables
  >(query, {
    skip: !serviceAvailable,
    fetchPolicy: 'network-only',
    nextFetchPolicy: 'cache-first',
    //pollInterval: 1000 * 60,
    variables,
    onError,
  });

  const data = useMap(_data, dataMap);
  const refetch = useRefetch(_refetch, dataMap);

  return {
    ...result,
    data,
    refetch,
  };
}
