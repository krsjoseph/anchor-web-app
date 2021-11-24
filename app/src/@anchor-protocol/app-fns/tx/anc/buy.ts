import { AddressProvider } from '@anchor-protocol/anchor.js';
import { validateInput } from '@anchor-protocol/anchor.js/dist/utils/validate-input';
import { validateAddress } from '@anchor-protocol/anchor.js/dist/utils/validation/address';
import {
  validateIsGreaterThanZero,
  validateIsNumber,
} from '@anchor-protocol/anchor.js/dist/utils/validation/number';
import {
  formatANCWithPostfixUnits,
  formatUSTWithPostfixUnits,
} from '@anchor-protocol/notation';
import { ANC, Gas, Rate, u, UST } from '@anchor-protocol/types';
import {
  pickAttributeValueByKey,
  pickEvent,
  pickRawLog,
  TxResultRendering,
  TxStreamPhase,
} from '@libs/app-fns';
import {
  _catchTxError,
  _createTxOptions,
  _pollTxInfo,
  _postTx,
  TxHelper,
} from '@libs/app-fns/tx/internal';
import { floor, min } from '@libs/big-math';
import { demicrofy } from '@libs/formatter';
import { QueryClient } from '@libs/query-client';
import { pipe } from '@rx-stream/pipe';
import { NetworkInfo, TxResult } from '@terra-money/use-wallet';
import {
  Coin,
  Coins,
  CreateTxOptions,
  Dec,
  Int,
  MsgExecuteContract,
  Fee,
} from '@terra-money/terra.js';
import big, { Big } from 'big.js';
import { Observable } from 'rxjs';
import { AnchorTax } from '../../types';

export function ancBuyTx(
  $: Parameters<typeof fabricatebBuy>[0] & {
    gasFee: Gas;
    gasAdjustment: Rate<number>;
    txFee: u<UST>;
    fixedGas: u<UST>;
    tax: AnchorTax;
    network: NetworkInfo;
    addressProvider: AddressProvider;
    queryClient: QueryClient;
    post: (tx: CreateTxOptions) => Promise<TxResult>;
    txErrorReporter?: (error: unknown) => string;
    onTxSucceed?: () => void;
  },
): Observable<TxResultRendering> {
  const helper = new TxHelper($);

  return pipe(
    _createTxOptions({
      msgs: fabricatebBuy($)($.addressProvider),
      fee: new Fee($.gasFee, floor($.txFee) + 'uusd'),
      gasAdjustment: $.gasAdjustment,
    }),
    _postTx({ helper, ...$ }),
    _pollTxInfo({ helper, ...$ }),
    ({ value: txInfo }) => {
      const rawLog = pickRawLog(txInfo, 0);

      if (!rawLog) {
        return helper.failedToFindRawLog();
      }

      const fromContract = pickEvent(rawLog, 'from_contract');

      if (!fromContract) {
        return helper.failedToFindEvents('from_contract');
      }

      try {
        const return_amount = pickAttributeValueByKey<u<ANC>>(
          fromContract,
          'return_amount',
        );
        const offer_amount = pickAttributeValueByKey<u<UST>>(
          fromContract,
          'offer_amount',
        );
        const spread_amount = pickAttributeValueByKey<u<ANC>>(
          fromContract,
          'spread_amount',
        );
        const commission_amount = pickAttributeValueByKey<u<ANC>>(
          fromContract,
          'commission_amount',
        );

        const pricePerANC =
          return_amount && offer_amount
            ? (big(return_amount).div(offer_amount) as UST<Big>)
            : undefined;
        const tradingFee =
          spread_amount && commission_amount
            ? (big(spread_amount).plus(commission_amount) as u<ANC<Big>>)
            : undefined;
        const txFee = offer_amount
          ? (big($.fixedGas).plus(
              min(big(offer_amount).mul($.tax.taxRate), $.tax.maxTaxUUSD),
            ) as u<UST<Big>>)
          : undefined;

        return {
          value: null,

          phase: TxStreamPhase.SUCCEED,
          receipts: [
            return_amount && {
              name: 'Bought',
              value:
                formatANCWithPostfixUnits(demicrofy(return_amount)) + ' ANC',
            },
            offer_amount && {
              name: 'Paid',
              value:
                formatUSTWithPostfixUnits(demicrofy(offer_amount)) + ' UST',
            },
            pricePerANC && {
              name: 'Paid/Bought',
              value: formatUSTWithPostfixUnits(pricePerANC) + ' UST',
            },
            tradingFee && {
              name: 'Trading Fee',
              value: formatANCWithPostfixUnits(demicrofy(tradingFee)) + ' ANC',
            },
            helper.txHashReceipt(),
            helper.txFeeReceipt(txFee),
          ],
        } as TxResultRendering;
      } catch (error) {
        return helper.failedToParseTxResult();
      }
    },
  )().pipe(_catchTxError({ helper, ...$ }));
}

interface Option {
  address: string;
  amount: string;
  denom: string;
  to?: string;
  beliefPrice?: string;
  maxSpread?: string;
}

export const fabricatebBuy =
  ({ address, amount, to, beliefPrice, maxSpread, denom }: Option) =>
  (addressProvider: AddressProvider): MsgExecuteContract[] => {
    validateInput([
      validateAddress(address),
      validateIsNumber(amount),
      validateIsGreaterThanZero(+amount),
    ]);

    const coins = new Coins([
      new Coin(denom, new Int(new Dec(amount).mul(1000000)).toString()),
    ]);
    const pairAddress = addressProvider.terraswapAncUstPair();
    return [
      new MsgExecuteContract(
        address,
        pairAddress,
        {
          swap: {
            offer_asset: {
              info: {
                native_token: {
                  denom: denom,
                },
              },
              amount: new Int(new Dec(amount).mul(1000000)).toString(),
            },
            belief_price: beliefPrice,
            max_spread: maxSpread,
            to: to,
          },
        },
        coins,
      ),
    ];
  };
