import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { fromPairs } from 'lodash';

import { ContractFactory } from '~contract';
import { NetworkProviderService } from '~network-provider/network-provider.service';
import { ContractType } from '~position/contract.interface';
import { PositionBalanceFetcherRegistry } from '~position/position-balance-fetcher.registry';
import { PositionFetcherRegistry } from '~position/position-fetcher.registry';
import { AppTokenTemplatePositionFetcher } from '~position/template/app-token.template.position-fetcher';
import { ContractPositionTemplatePositionFetcher } from '~position/template/contract-position.template.position-fetcher';
import { Network } from '~types/network.interface';

import { TokenBalanceResponse } from './balance-fetcher.interface';
import { BalanceFetcherRegistry } from './balance-fetcher.registry';
import { BalancePresentationService } from './balance-presentation.service';
import { BalancePresenterRegistry } from './balance-presenter.registry';
import { DefaultBalancePresenterFactory } from './default.balance-presenter.factory';
import { DefaultContractPositionBalanceFetcherFactory } from './default.contract-position-balance-fetcher.factory';
import { DefaultTokenBalanceFetcherFactory } from './default.token-balance-fetcher.factory';
import { GetBalancesParams } from './dto/get-balances-params.dto';
import { GetBalancesQuery } from './dto/get-balances-query.dto';

@Injectable()
export class BalanceService {
  private logger = new Logger(BalanceService.name);
  private readonly contractFactory: ContractFactory;

  constructor(
    @Inject(BalanceFetcherRegistry) private readonly balanceFetcherRegistry: BalanceFetcherRegistry,
    @Inject(PositionFetcherRegistry) private readonly positionFetcherRegistry: PositionFetcherRegistry,
    @Inject(PositionBalanceFetcherRegistry)
    private readonly positionFetcherBalanceFetcherRegistry: PositionBalanceFetcherRegistry,
    @Inject(BalancePresenterRegistry) private readonly balancePresenterRegistry: BalancePresenterRegistry,
    @Inject(NetworkProviderService) private readonly networkProviderService: NetworkProviderService,
    @Inject(DefaultBalancePresenterFactory)
    private readonly defaultBalancePresenterFactory: DefaultBalancePresenterFactory,
    @Inject(DefaultTokenBalanceFetcherFactory)
    private readonly defaultTokenBalanceFetcherFactory: DefaultTokenBalanceFetcherFactory,
    @Inject(DefaultContractPositionBalanceFetcherFactory)
    private readonly defaultContractPositionBalanceFetcherFactory: DefaultContractPositionBalanceFetcherFactory,

    @Inject(BalancePresentationService)
    private readonly balancePresentationService: BalancePresentationService,
  ) {
    this.contractFactory = new ContractFactory((network: Network) => this.networkProviderService.getProvider(network));
  }

  private async getBalancesLegacyStrategy({ appId, addresses, network }: GetBalancesQuery & GetBalancesParams) {
    const fetcher = this.balanceFetcherRegistry.get(appId, network)!;

    const addressBalancePairs = await Promise.all(
      addresses.map(async address => {
        const balances = await fetcher.getBalances(address).catch(e => {
          this.logger.error(`Failed to fetch balance for ${appId} on network ${network}: ${e.stack}`);
          return { error: e.message } as TokenBalanceResponse;
        });

        return [address, balances];
      }),
    );

    return fromPairs(addressBalancePairs);
  }

  private async getBalancesGeneralizedStrategy({ appId, addresses, network }: GetBalancesQuery & GetBalancesParams) {
    const tokenGroupIds = this.positionFetcherRegistry.getGroupIdsForApp({
      type: ContractType.APP_TOKEN,
      network,
      appId,
    });

    const positionGroupIds = this.positionFetcherRegistry.getGroupIdsForApp({
      type: ContractType.POSITION,
      network,
      appId,
    });

    // If there is no custom fetcher defined, and there are no token/contract position groups defined, declare 404
    if (!tokenGroupIds.length && !positionGroupIds.length)
      throw new NotFoundException(`Protocol ${appId} is not supported on network ${network}`);

    const addressBalancePairs = await Promise.all(
      addresses.map(async address => {
        const [tokenBalances, contractPositionBalances] = await Promise.all([
          await Promise.all(
            tokenGroupIds.map(async groupId => {
              const fetcherSelector = { type: ContractType.APP_TOKEN, appId, groupId, network };

              const templateFetcher = this.positionFetcherRegistry.get(fetcherSelector);
              if (templateFetcher instanceof AppTokenTemplatePositionFetcher)
                return templateFetcher.getBalances(address);

              const balanceFetcher = this.positionFetcherBalanceFetcherRegistry.get(fetcherSelector);
              if (balanceFetcher) return balanceFetcher.getBalances(address);

              const defaultBalanceFetcher = this.defaultTokenBalanceFetcherFactory.build(fetcherSelector);
              return defaultBalanceFetcher.getBalances(address);
            }),
          ),
          await Promise.all(
            positionGroupIds.map(async groupId => {
              const fetcherSelector = { type: ContractType.POSITION, appId, groupId, network };
              const templateFetcher = this.positionFetcherRegistry.get(fetcherSelector);
              if (templateFetcher instanceof ContractPositionTemplatePositionFetcher)
                return templateFetcher.getBalances(address);

              const balanceFetcher = this.positionFetcherBalanceFetcherRegistry.get(fetcherSelector);
              if (balanceFetcher) return balanceFetcher.getBalances(address);

              const defaultBalanceFetcher = this.defaultContractPositionBalanceFetcherFactory.build(fetcherSelector);
              return defaultBalanceFetcher.getBalances(address);
            }),
          ),
        ]);

        const preprocessed = [...tokenBalances.flat(), ...contractPositionBalances.flat()];
        const presentedBalances = await this.balancePresentationService.present({
          appId,
          network,
          address,
          balances: preprocessed,
        });
        return [address, presentedBalances];
      }),
    );

    return fromPairs(addressBalancePairs);
  }

  async getBalances({ appId, addresses, network }: GetBalancesQuery & GetBalancesParams) {
    // @TODO there is no 404 thrown anymore if there is no balance fetcher... add appId validation at least
    return this.balanceFetcherRegistry.get(appId, network)
      ? this.getBalancesLegacyStrategy({ appId, addresses, network })
      : this.getBalancesGeneralizedStrategy({ appId, addresses, network });
  }
}
