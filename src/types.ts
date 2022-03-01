import { BN } from "@project-serum/anchor";
import { Cluster, PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";

export type SerumMarket = {
    marketAddress: string
    requestQueue: string
    eventQueue: string
    baseVault: string
    quoteVault: string
    vaultOwner: string
    bidsAddress: string
    asksAddress: string
}

export enum SystemMode {
    Recovery, Normal
}

export type Config = {
    env: Cluster,
    borrowing: {
        programId: string,
        accounts: {
            stablecoinMint: string
            stablecoinMintAuthority: string
            hbbMintAuthority: string
            collateralVaultsAuthority: string
            collateralVault: {
                [key: string]: string
            }
            redemptionsQueue: string,
            redemptionCandidatesQueue: string,
            liquidationsQueue: string,
            borrowingMarketState: string,
            stabilityPoolState: string,
            epochToScaleToSum: string,
            stablecoinStabilityPoolVault: string,
            stabilityVaults: string,
            stablecoinStabilityPoolVaultAuthority: string,
            mint: {
                [key: string]: string
            }
            liquidationRewardsVaultAuthority: string,
            borrowingVaults: string,
            globalConfig: string,
            oracleMappings: string,
            stakingPoolState: string,
            borrowingFeesAccount: string,
            borrowingFeesVaultAuthority: string,
            stakingVault: string,
            treasuryVault: string,
            burningVault: string,
            burningVaultAuthority: string,
            USDC: string,
            pyth: {
                [key: string]: string
            }
            serumMarkets: {
                [key: string]: SerumMarket
            },
            saber: {
                stablecoinSwap: string
            }
        }
    }
}


export type GlobalConfig = {
    version: number
    borrowingMarketState: PublicKey
    userBorrowMin: BN | Decimal
    userBorrowMax: BN | Decimal
    userDebtMin: BN | Decimal
    userDebtMax: BN | Decimal
    totalDebtMax: BN | Decimal
    treasuryFeeRate: BN | Decimal
    protocolEpoch: BN | Decimal
    redemptionBootstrapPeriod: BN | Decimal
    oracleProgramId: PublicKey
    delegateCollateralAllowActiveOnly: boolean
    blockWithdrawCollateral: boolean
    blockTryLiquidate: boolean
    blockBorrow: boolean
    blockDepositAndBorrow: boolean
    blockClearLiquidationGains: boolean
    blockHarvestLiquidationGains: boolean
    blockWithdrawStability: boolean
    blockAirdropHbb: boolean
    blockClearRedemptionOrder: boolean
    emergencyMode: boolean
    userDepositMax: BN | Decimal
    totalDepositMax: BN | Decimal
    issuancePerMinute: BN | Decimal
    useIssuancePerMinute: boolean
    padding1: Array<BN | Decimal>
    padding2: Array<BN | Decimal>
    padding3: Array<BN | Decimal>
}

export type BorrowingMarketState = {
    version: number
    initialMarketOwner: PublicKey
    redemptionsQueue: PublicKey
    redemptionCandidatesQueue: PublicKey
    stablecoinMint: PublicKey
    stablecoinMintAuthority: PublicKey
    stablecoinMintSeed: number
    hbbMint: PublicKey
    hbbMintAuthority: PublicKey
    hbbMintSeed: number
    numUsers: BN | Decimal
    numActiveUsers: BN | Decimal
    stablecoinBorrowed: BN | Decimal
    depositedCollateral: CollateralAmounts
    inactiveCollateral: CollateralAmounts
    baseRateBps: BN | Decimal
    lastFeeEvent: BN | Decimal
    redistributedStablecoin: BN | Decimal
    totalStake: BN | Decimal
    collateralRewardPerToken: TokenMap
    stablecoinRewardPerToken: BN | Decimal
    totalStakeSnapshot: BN | Decimal
    borrowedStablecoinSnapshot: BN | Decimal
    padding: Array<BN | Decimal>
}

export type BorrowingVaults = {
    borrowingMarketState: PublicKey
    burningVault: PublicKey
    burningVaultAuthority: PublicKey
    burningVaultSeed: number
    borrowingFeesVault: PublicKey
    borrowingFeesVaultAuthority: PublicKey
    borrowingFeesVaultSeed: number
    collateralVaultSol: PublicKey
    collateralVaultSrm: PublicKey
    collateralVaultEth: PublicKey
    collateralVaultBtc: PublicKey
    collateralVaultRay: PublicKey
    collateralVaultFtt: PublicKey
    collateralVaultMsol: PublicKey
    collateralVaultsAuthority: PublicKey
    collateralVaultsSeed: number
    srmMint: PublicKey
    ethMint: PublicKey
    btcMint: PublicKey
    rayMint: PublicKey
    fttMint: PublicKey
    msolMint: PublicKey
    padding: Array<BN | Decimal>
}

export type OracleMappings = {
    borrowingMarketState: PublicKey
    pythSolPriceInfo: PublicKey
    pythSrmPriceInfo: PublicKey
    pythEthPriceInfo: PublicKey
    pythBtcPriceInfo: PublicKey
    pythRayPriceInfo: PublicKey
    pythFttPriceInfo: PublicKey
    pythMsolPriceInfo: PublicKey
    reserved: Array<BN | Decimal>
}

export type StabilityPoolState = {
    borrowingMarketState: PublicKey
    epochToScaleToSum: PublicKey
    liquidationsQueue: PublicKey
    version: number
    numUsers: BN | Decimal
    totalUsersProvidingStability: BN | Decimal
    stablecoinDeposited: BN | Decimal
    hbbEmissionsStartTs: BN | Decimal
    cumulativeGainsTotal: StabilityTokenMap
    pendingCollateralGains: StabilityTokenMap
    currentEpoch: BN | Decimal
    currentScale: BN | Decimal
    p: BN | Decimal
    lastStablecoinLossErrorOffset: BN | Decimal
    lastCollLossErrorOffset: StabilityCollateralAmounts
    lastIssuanceTimestamp: BN | Decimal
    padding: Array<BN | Decimal>
}

export type StabilityVaults = {
    stabilityPoolState: PublicKey
    stablecoinStabilityPoolVault: PublicKey
    stablecoinStabilityPoolVaultAuthority: PublicKey
    publicKey: PublicKey
    stablecoinStabilityPoolVaultSeed: number
    liquidationRewardsVaultSol: PublicKey
    liquidationRewardsVaultSrm: PublicKey
    liquidationRewardsVaultEth: PublicKey
    liquidationRewardsVaultBtc: PublicKey
    liquidationRewardsVaultRay: PublicKey
    liquidationRewardsVaultFtt: PublicKey
    liquidationRewardsVaultMsol: PublicKey
    liquidationRewardsVaultAuthority: PublicKey
    liquidationRewardsVaultSeed: number
    padding: Array<BN | Decimal>
}

export type UserMetadata = {
    version: number
    status: number
    userId: BN | Decimal
    metadataPk: PublicKey
    owner: PublicKey
    borrowingMarketState: PublicKey
    padding1: Array<BN | Decimal>
    inactiveCollateral: CollateralAmounts
    depositedCollateral: CollateralAmounts
    borrowedStablecoin: BN | Decimal
    userStake: BN | Decimal
    userCollateralRewardPerToken: TokenMap
    userStablecoinRewardPerToken: BN | Decimal
    padding2: Array<BN | Decimal>
}

export type StakingPoolState = {
    borrowingMarketState: PublicKey
    totalDistributedRewards: BN | Decimal
    rewardsNotYetClaimed: BN | Decimal
    version: number
    numUsers: BN | Decimal
    totalUsersProvidingStability: BN | Decimal
    totalStake: BN | Decimal
    rewardPerToken: BN | Decimal
    prevRewardLoss: BN | Decimal
    stakingVault: PublicKey
    stakingVaultAuthority: PublicKey
    stakingVaultSeed: number
    treasuryVault: PublicKey
    treasuryVaultAuthority: PublicKey
    treasuryVaultSeed: number
    padding: Array<BN | Decimal>
}

export type UserStakingState = {
    version: number
    userId: BN | Decimal
    stakingPoolState: PublicKey
    owner: PublicKey
    userStake: BN | Decimal
    rewardsTally: BN | Decimal
    padding: Array<BN | Decimal>
}

export type StabilityProviderState = {
    version: number
    stabilityPoolState: PublicKey
    owner: PublicKey
    userId: BN | Decimal
    depositedStablecoin: BN | Decimal
    userDepositSnapshot: DepositSnapshot
    cumulativeGainsPerUser: StabilityTokenMap
    pendingGainsPerUser: StabilityCollateralAmounts
    padding: Array<BN | Decimal>
}

export type EpochToScaleToSumAccount = {
    data: Array<BN | Decimal>
}

export type RedemptionsQueue = {
    orders: Array<RedemptionOrder>
    nextIndex: BN | Decimal
}

export type RedemptionCandidatesQueue = {
    candidateUsers: Array<CandidateRedemptionUser>
    nextIndex: BN | Decimal
}

export type LiquidationsQueue = {
    len: BN | Decimal
    events: Array<LiquidationEvent>
}

export type DepositSnapshot = {
    sum: StabilityTokenMap
    product: BN | Decimal
    scale: BN | Decimal
    epoch: BN | Decimal
    enabled: boolean
}

export type CandidateRedemptionUser = {
    status: BN | Decimal
    userId: BN | Decimal
    userMetadata: PublicKey
    debt: BN | Decimal
    collateralRatio: BN | Decimal
    fillerMetadata: PublicKey
}

export type RedemptionOrder = {
    id: BN | Decimal
    status: BN | Decimal
    baseRate: BN | Decimal
    lastReset: BN | Decimal
    redeemerUserMetadata: PublicKey
    redeemer: PublicKey
    requestedAmount: BN | Decimal
    remainingAmount: BN | Decimal
    redemptionPrices: TokenPrices
}

export type LiquidationEvent = {
    status: BN | Decimal
    userPositions: PublicKey
    positionIndex: BN | Decimal
    liquidator: PublicKey
    eventTs: BN | Decimal
    collateralGainToLiquidator: CollateralAmounts
    collateralGainToClearer: CollateralAmounts
    collateralGainToStabilityPool: CollateralAmounts
}

export type TokenMap = {

    sol: BN | Decimal
    eth: BN | Decimal
    btc: BN | Decimal
    srm: BN | Decimal
    ray: BN | Decimal
    ftt: BN | Decimal
    msol: BN | Decimal
    reserved: Array<BN | Decimal>

}
export type StabilityTokenMap = {

    sol: BN | Decimal
    eth: BN | Decimal
    btc: BN | Decimal
    srm: BN | Decimal
    ray: BN | Decimal
    ftt: BN | Decimal
    msol: BN | Decimal
    reserved: Array<BN | Decimal>

}
export type Price = {
    value: BN | Decimal
    exp: BN | Decimal
}
export type TokenPrices = {
    sol: Price
    eth: Price
    btc: Price
    srm: Price
    ray: Price
    ftt: Price
    msol: Price
    reserved: Array<BN | Decimal>
}
export type CollateralAmounts = {
    sol: BN | Decimal
    eth: BN | Decimal
    btc: BN | Decimal
    srm: BN | Decimal
    ray: BN | Decimal
    ftt: BN | Decimal
    msol: BN | Decimal
    reserved: Array<BN | Decimal>
}

export type CollateralAmountsDecimal = {
    sol: Decimal
    eth: Decimal
    btc: Decimal
    srm: Decimal
    ray: Decimal
    ftt: Decimal
    msol: Decimal
    reserved: Array<Decimal>
}

export type StabilityCollateralAmounts = {
    sol: BN | Decimal
    eth: BN | Decimal
    btc: BN | Decimal
    srm: BN | Decimal
    ray: BN | Decimal
    ftt: BN | Decimal
    msol: BN | Decimal
    reserved: Array<BN | Decimal>
}

export type CollateralInfo = {
    collateralRatio: BN | Decimal
}

export enum EventStatus {
    Inactive, PendingCollection
}

export enum CollateralTokenActive {
    SOL,
    ETH,
    BTC,
    SRM,
    RAY,
    FTT,
    MSOL
}