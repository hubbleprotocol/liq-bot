import { Idl, Program, ProgramAccount, Provider, Wallet } from "@project-serum/anchor";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AccountMeta, Cluster, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";
import axios from "axios";
import * as bs58 from 'bs58';
import { BorrowingMarketState, CollateralAmounts, CollateralInfo, CollateralTokenActive, Config, EventStatus, LiquidationsQueue, SystemMode, TokenMap, TokenPrices, UserMetadata } from "./types";
import BN from 'bn.js';
import { TpuConnection } from "./tpuClient";
import { PriceData, parsePriceData, PriceStatus } from "@pythnetwork/client";
import { DECIMAL_FACTOR, STABLECOIN_DECIMALS, LAMPORTS_PER_SOL, DECIMALS_BTC, LAMPORTS_PER_MSOL, DECIMALS_RAY, DECIMALS_FTT, DECIMALS_ETH, DECIMALS_SRM } from "@hubbleprotocol/hubble-sdk";
import Decimal from "decimal.js";

require('dotenv').config();

// get the IDL from the https API
async function getIDL() : Promise<Idl> {
    return (await axios.get('https://api.hubbleprotocol.io/idl')).data[0] as Idl;
}

async function getConfigs(): Promise<Array<Config>> {
    return (await axios.get('https://api.hubbleprotocol.io/config')).data as Array<Config>;
}

export function getMintFromConfig(config: Config, coin: string) : string {
    return config.borrowing.accounts['liquidationRewardsVault'+coin[0].toUpperCase()+coin.substring(1).toLowerCase()];
}

function getWallet(): Wallet {
	const botKeyEnvVariable = "BOT_KEY";
	// ENVIRONMENT VARIABLE FOR THE BOT PRIVATE KEY
	const botKey = process.env[botKeyEnvVariable];

	if (botKey === undefined) {
		console.error('need a ' + botKeyEnvVariable +' env variable');
		process.exit();
	}
	// setup wallet
	let keypair;

	try {
		keypair = Keypair.fromSecretKey(
			bs58.decode(botKey, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
		);
	} catch {
		try {
			keypair = Keypair.fromSecretKey(
				Uint8Array.from(JSON.parse(botKey))
			);
		} catch {
			console.error('Failed to parse private key from Uint8Array (solana-keygen) and base58 encoded string (phantom wallet export)');
			process.exit();
		}
	}
	return new Wallet(keypair);
}

class Bot {

    liquidator: Liquidator;
    intervals: Array<NodeJS.Timer>

    constructor(liquidator: Liquidator) {
        this.liquidator = liquidator;
        this.intervals = new Array<NodeJS.Timer>();
    }

    static async create() {
        // retrieve the IDL from https api
        const idl = await getIDL();
        // retrieve the configs from the https api
        const configs = await getConfigs();

        const liquidator = await Liquidator.load(idl, configs);
        return new Bot(liquidator);
    }

    async stop() {
        this.liquidator.pollingAccountsFetcher.stop();
        delete this.liquidator;
        await Promise.all(this.intervals.map(interval => {
            clearInterval(interval);
        }));
        this.intervals = new Array<NodeJS.Timer>();
    }

    async start() {

        // check the idl and the configs for updates every minute
        this.intervals.push(setInterval(async function() {
    
            const idl = await getIDL();
            const configs = await getConfigs();
            const bot = (this as Bot);
            if (JSON.stringify(bot.liquidator.idl) !== JSON.stringify(idl) && JSON.stringify(bot.liquidator.configs) !== JSON.stringify(configs)) {
                bot.stop();
                bot.liquidator = await Liquidator.load(idl, configs);
                bot.start();
            }
            
        }.bind(this as Bot), 60 * 1000));
    
        // load all the current users into the liquidator & account fetcher
        await this.liquidator.getUserMetadatas();
    
        // start the account fetcher (will update the users, market state, token prices, and any account which you throw at it)
        this.liquidator.pollingAccountsFetcher.start();
    
        // try to liquidate users every half second
        this.intervals.push(setInterval(async function() {
            this.liquidator.tryLiquidateUsers();
        }.bind(this as Bot), 1000));
    
        // get new users every 30 seconds
        this.intervals.push(setInterval(async function() {
            this.liquidator.getUserMetadatas();
        }.bind(this as Bot), 30 * 1000));
        
        // get a new blockhash every second
        this.intervals.push(setInterval(async function() {
            this.liquidator.blockhash = (await this.liquidator.hubbleProgram.provider.connection.getRecentBlockhash()).blockhash;
        }.bind(this as Bot), 1000));
    }


}



async function main() {
    try {
        const bot = await Bot.create();
        bot.start();
    } catch(error) {
        console.error(error);
    }
    
}

export type LiquidatorAssociatedTokenAccounts = {
    [key in CollateralTokenActive]: string;
};

export type Loan = {
    metadata: UserMetadata,
    usdhDebt: BN | Decimal
    collateral: CollateralAmounts,
    tcr: BN | Decimal
}

export class Liquidator {
    cluster: Cluster
    idl: Idl
    configs: Array<Config>
    clusterConfig: Config
    wallet: Wallet
    hubbleProgram: Program<Idl>
    borrowingMarketState: BorrowingMarketState
    liquidationsQueue: LiquidationsQueue
    liquidatorAssociatedTokenAccounts: LiquidatorAssociatedTokenAccounts
    userMetadataMap: Map<string, UserMetadata>;
    liquidationIXMap: Map<string, TransactionInstruction>;
    clearLiquidationGainsIXMap: Map<string, TransactionInstruction>;
    pollingAccountsFetcher: PollingAccountsFetcher;
    blockhash: string
    prices: TokenPrices
    mcr: BN | Decimal


    // create the clearLiquidationGains TransactionInstruction for the liquidator running this bot
    // will need to be called for each token
    async getClearLiquidationGainsIX(token: string, clearerAassociatedTokenAccount: PublicKey) : Promise<TransactionInstruction> {
        const args = [CollateralTokenActive[token]];
        const keys = [
            {
                pubkey: this.hubbleProgram.provider.wallet.publicKey, // clearingAgent
                isWritable: true,
                isSigner: true
            },
            {
                pubkey: clearerAassociatedTokenAccount, // clearingAgentAta
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.borrowingMarketState), // borrowingMarketState
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.globalConfig), // globalConfig
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.borrowingVaults), // borrowingVaults
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.stabilityPoolState), // stabilityPoolState
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.stabilityVaults), // stabilityVaults
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.liquidationsQueue), // liquidationsQueue
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.collateralVault[token]), // collateralVault
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.collateralVaultsAuthority), // collateralVaultsAuthority
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts['liquidationRewardsVault' + token[0] + token.substring(1).toLowerCase()]), // liquidationRewardsVault
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: TOKEN_PROGRAM_ID, // tokenProgram
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: SYSVAR_CLOCK_PUBKEY, // clock
                isWritable: false,
                isSigner: false
            }
        ] as AccountMeta[];
        return new TransactionInstruction({
            data: this.hubbleProgram.coder.instruction.encode('clearLiquidationGains', args),
            programId: this.hubbleProgram.programId,
            keys: keys
        });
        
    }
    
    // create the `tryLiquidate` TransactionInstruction for specified UserMetadata account
    async getTryLiquidateIX(userMetadata: PublicKey): Promise<TransactionInstruction> {
        const args = [];
        const keys = [
            {
                pubkey: this.hubbleProgram.provider.wallet.publicKey, // liquidator
                isWritable: true,
                isSigner: true
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.borrowingMarketState), // borrowingMarketState
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.globalConfig), //globalConfig
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.stabilityPoolState), // stabilityPoolState
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: userMetadata, //userMetadata
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.epochToScaleToSum), //epochToScaleToSum
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.stabilityVaults), //stabilityVaults
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.borrowingVaults), // borrowingVaults
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.liquidationsQueue), // liquidationsQueue
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.stablecoinMint), // stablecoinMint
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.stablecoinMintAuthority), // stablecoinMintAuthority
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.stablecoinStabilityPoolVault), // stablecoinStabilityPoolVault
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.stablecoinStabilityPoolVaultAuthority), // stablecoinStabilityPoolVaultAuthority
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.oracleMappings), // oracleMappings
                isWritable: false,
                isSigner: false
            },
        ].concat(...Object.keys(CollateralTokenActive).filter(token => isNaN(parseInt(token))).map(token => {
            return {
                pubkey: new PublicKey(this.clusterConfig.borrowing.accounts.pyth[token.toLowerCase() + 'PriceInfo']), // pythPriceInfo
                isWritable: false,
                isSigner: false
            };
        })).concat(...[
            {
                pubkey: TOKEN_PROGRAM_ID, // tokenProgram
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: SYSVAR_CLOCK_PUBKEY, // clock
                isWritable: false,
                isSigner: false
            }
        ]) as AccountMeta[];
        return new TransactionInstruction({
            data: this.hubbleProgram.coder.instruction.encode('tryLiquidate', args),
            programId: this.hubbleProgram.programId,
            keys: keys
        });
    }


    // clear the liquidation queue
    async clearLiquidationQueue() : Promise<void> {

        // filter the liquidation queue for events which are pending collection
        const filteredLiquidationQueue = this.liquidationsQueue.events.filter(e => e.status.toNumber() === EventStatus.PendingCollection);
        // loop through each liquidation event
        await Promise.all(filteredLiquidationQueue.map((pendingEvent, index) => {
            return new Promise((resolve) => { 
                // 1 second timeout per liquidation event
                setTimeout(async () => {
                    resolve(await this.clearLiquidationGains());
                }, 1000 * index);
            });
        }));
    }

    //
    async clearLiquidationGains() : Promise<Array<string>> {
        const chunkOf5Tokens = chunk(Object.keys(CollateralTokenActive).filter(token => isNaN(parseInt(token))), 5) as Array<Array<string>>;
        return flat(await Promise.all(chunkOf5Tokens.map(async (chunkedTokenAccounts, chunkIndex) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    const tx = new Transaction();
                    chunkedTokenAccounts.forEach(async tokenAccount => {
                        tx.add(this.clearLiquidationGainsIXMap.get(CollateralTokenActive[tokenAccount]));
                    });
                    tx.feePayer = this.hubbleProgram.provider.wallet.publicKey;
                    tx.recentBlockhash = this.blockhash;
                    this.hubbleProgram.provider.wallet.signTransaction(tx).then(tx => {
                        (this.hubbleProgram.provider.connection as TpuConnection).sendRawTransaction(tx.serialize()).then(signature => {
                            resolve(signature);
                        });
                    });
                }, 1000 * chunkIndex);
            });
        })));
        
    }


    async getPendingDebt(user : UserMetadata) : Promise<Decimal> {
        const diffStableRpt = new Decimal(this.borrowingMarketState.stablecoinRewardPerToken.toString()).minus(new Decimal(user.userStablecoinRewardPerToken.toString()));
        return user.status !== 1 || diffStableRpt.isZero()
            ? new Decimal(0)
            : diffStableRpt.mul(new Decimal(user.userStake.toString())).dividedBy(DECIMAL_FACTOR);
    }

    async calculateTotalDebt(user: UserMetadata) : Promise<Decimal> {
        const pendingDebt = await this.getPendingDebt(user);
        return new Decimal(user.borrowedStablecoin.toString()).plus(pendingDebt).dividedBy(new Decimal(STABLECOIN_DECIMALS));
    }

    zeroCollateral() : CollateralAmounts {
        const keys = Object.keys(this.borrowingMarketState.collateralRewardPerToken).filter(key => !Array.isArray(this.borrowingMarketState.collateralRewardPerToken[key]));
        const zeroCollateral = {} as TokenMap;
        keys.forEach(key => {
            zeroCollateral[key] = new Decimal(0);
        });
        return zeroCollateral;
    }

    mulFrac(collateralAmmounts: CollateralAmounts, numerator: BN | Decimal, denominator: BN | Decimal) : TokenMap {
        Object.keys(collateralAmmounts).filter(key => Array.isArray(collateralAmmounts[key])).forEach(key => {
            collateralAmmounts[key] = collateralAmmounts[key].dividedBy(denominator).mul(numerator);
        });
        return collateralAmmounts;

    }

    // 
    async getPendingCollateral(user : UserMetadata) : Promise<CollateralAmounts> {
        const diffCollRpt = this.zeroCollateral() as CollateralAmounts;
        Object.keys(this.borrowingMarketState.collateralRewardPerToken).filter(key => !Array.isArray(this.borrowingMarketState.collateralRewardPerToken[key])).forEach(key => {
            diffCollRpt[key] = this.borrowingMarketState.collateralRewardPerToken[key].sub(user.userCollateralRewardPerToken[key]);
        });
        return user.status !== 1 || !Object.keys(diffCollRpt).some(key => !diffCollRpt[key].isZero())
            ? this.zeroCollateral() as TokenMap
            : this.mulFrac(diffCollRpt, new Decimal(user.userStake.toString()), DECIMAL_FACTOR);
    }

    async addCollateralAmounts(collateralAmounts: Array<CollateralAmounts>) : Promise<CollateralAmounts> {
        const keys = Object.keys(collateralAmounts[0]).filter(key => !Array.isArray(collateralAmounts[0][key]));
        return collateralAmounts.reduce((a, b) => {
            keys.forEach(key => {
                a[key] = a[key].plus(b[key]);
            });
            return a;
        }, this.zeroCollateral());
    }

    precisionFromKey(key: string): Decimal {
        switch(key) {
            case 'sol': return new Decimal(LAMPORTS_PER_SOL);
            case 'btc': return new Decimal(DECIMALS_BTC);
            case 'msol': return new Decimal(LAMPORTS_PER_MSOL);
            case 'ray': return new Decimal(DECIMALS_RAY);
            case 'ftt': return new Decimal(DECIMALS_FTT);
            case 'eth': return new Decimal(DECIMALS_ETH);
            case 'srm': return new Decimal(DECIMALS_SRM);
        }
        return new Decimal(1);
    }

    lamportsToDecimal(collateralAmounts: CollateralAmounts) : CollateralAmounts {
        // create a new collateral amounts object to avoid modifying the data associated with the user metadata
        const newCollateralAmounts = { } as CollateralAmounts;

        // filter through the collateral amounts parameter and divide by the precision based on the asset
        Object.keys(collateralAmounts).filter(key => !Array.isArray(collateralAmounts[key])).forEach(key => {
            newCollateralAmounts[key] = new Decimal(collateralAmounts[key].toString()).div(this.precisionFromKey(key));
        });

        return newCollateralAmounts;
    }

    // add together deposited collateral, inactive collateral and pending collateral for the specified UserMetadata
    async calculateTotalCollateral(user: UserMetadata) : Promise<CollateralAmounts> {
        return await this.addCollateralAmounts([this.lamportsToDecimal(user.depositedCollateral), this.lamportsToDecimal(user.inactiveCollateral), this.lamportsToDecimal(await this.getPendingCollateral(user))]);
    }

    // calculate the loans associated with each UserMetadata in the array
    // sum(collateral * price) / debt
    // divided by 100 to get the ratio 
    async getLoans(metadatas: Array<UserMetadata>): Promise<Array<Loan>> {
        return (await Promise.all(metadatas.filter(metadata => new Decimal(metadata.borrowedStablecoin.toString()).gt(new Decimal(0))).map(async metadata => {
            return {
                metadata,
                usdhDebt: await this.calculateTotalDebt(metadata),
                collateral: await this.calculateTotalCollateral(metadata)
            } as Loan;
        }))).map((loan) => {
            return {
                ...loan,
                tcr: Object.keys(loan.collateral).filter(key => !Array.isArray( loan.collateral[key] ) ).map(key => (new Decimal(loan.collateral[key].toString())).mul(this.prices[key].value)).reduce((a, b) => a.plus(b), new Decimal(0)).div((new Decimal(loan.usdhDebt.toString()))).mul(new Decimal(100))
            };
        });
    }

    // get the loans for each userMetadata
    async tryLiquidateUsers() : Promise<void> {
        
        // get loan (tcr) associated with each user metadata
        // filter for the account data from the polling account fetcher which have userMetadata as the accountKey
        // this will save the most RAM since these accounts are going to be taking up the most of the accounts memory allocation

        const loans = await this.getLoans([...this.pollingAccountsFetcher.accounts.values()].filter(acc => acc.accountKey === 'userMetadata').map(acc => acc.data as UserMetadata));
        // loop through each loan and try to liquidate
        const sortedLoans = loans.sort((loanA, loanB) => loanA.tcr.toNumber() - loanB.tcr.toNumber());
        // const topLoan = sortedLoans[0];
        // if (!(topLoan.tcr as Decimal).eq(new Decimal(0))) {
        //     console.log(`${topLoan.metadata.metadataPk.toBase58()} - ${(1/(topLoan.tcr.toNumber()/100) * 100).toFixed(2)} %`);
        // }
        sortedLoans.forEach(async loan => {
            // initially all loan tcr's will be ZERO
            if (!(loan.tcr as Decimal).eq(new Decimal(0))) {
                const mcrRange = (this.mcr as Decimal).plus(new Decimal(10 * 0.0001));
                const liquidatable = (loan.tcr as Decimal).lt(mcrRange);
                const ltv = 1/(loan.tcr.toNumber()/100);
                // console.log(`liquidatable ${liquidatable} - mcr ${mcrRange.toNumber()} - tcr: ${loan.tcr.toNumber().toFixed(2)} - ltv ${(ltv * 100).toFixed(2)}`);
                
                if (liquidatable) {
                    console.log(`${loan.metadata.metadataPk.toBase58()} has ltv ${(ltv * 100).toFixed(2)} attempting to liquidate`);
                    let tx = new Transaction().add(this.liquidationIXMap.get(loan.metadata.metadataPk.toBase58()));
                    tx.recentBlockhash = this.blockhash;
                    tx.feePayer = this.hubbleProgram.provider.wallet.publicKey;
                    tx = await this.hubbleProgram.provider.wallet.signTransaction(tx);
                    (this.hubbleProgram.provider.connection as TpuConnection).sendRawTransaction(tx.serialize());
                }
            }
        });


    }
    
    
    async getUserMetadatas() : Promise<void> {

        // retrieve all the user metadatas from on chain
        const userMetadataProgramAccounts = ((await this.hubbleProgram.account.userMetadata.all()) as Array<ProgramAccount<UserMetadata>>);
        
        // loop through all the metadata and load new ones 
        let usersLoaded = 0;
        (await Promise.all(userMetadataProgramAccounts.map(async programAccount => {

            if (!this.pollingAccountsFetcher.accounts.has(programAccount.account.metadataPk.toBase58()) && programAccount.account.borrowingMarketState.toBase58() === this.clusterConfig.borrowing.accounts.borrowingMarketState) {
                
                
                // add the userMetadata account to the polling account fetcher
                // preload the programAccount data to the polling accounts fetcher

                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                this.pollingAccountsFetcher.addProgram('userMetadata', programAccount.account.metadataPk.toBase58(), this.hubbleProgram, (userMetadata: UserMetadata) => {

                    // check if this user metadata is from an old config
                    // remove from the polling accounts fetcher
                    if (userMetadata.borrowingMarketState.toBase58() !== this.clusterConfig.borrowing.accounts.borrowingMarketState) {
                        console.log(`removing ${userMetadata.metadataPk.toBase58()} from the polling account fetcher because of difference in market state key`);
                        this.pollingAccountsFetcher.accounts.delete(userMetadata.metadataPk.toBase58());
                    }

                }, (error: any) => { console.error(error); }, programAccount.account);

                // we can preload the transaction instruction to save compute time
                this.liquidationIXMap.set(programAccount.account.metadataPk.toBase58(), await this.getTryLiquidateIX(programAccount.account.metadataPk));

                usersLoaded += 1;
            }
        })));

        if (usersLoaded > 0) {
            console.log('loaded ' + usersLoaded + ' new users');
        }
            
        
    }

    // loop through the protocol deposited collateral for each token, multiple by the price and divide by the precision of the collateral asset
    async totalDepositedCollateral() : Promise<BN | Decimal> {
        return Object.keys(this.borrowingMarketState.depositedCollateral).filter(key => !Array.isArray(this.borrowingMarketState.depositedCollateral[key])).map(key => {
            return new Decimal(this.borrowingMarketState.depositedCollateral[key].toString()).div(this.precisionFromKey(key)).mul(this.prices[key].value);
        }).reduce((a, b) => a.plus(b), new Decimal(0));
    }

    // loop through the protocol deposited collateral for each token, multiple by the price and divide by the precision of the collateral asset
    // divide by the amount of borrowed stablecoin (usdh) and divide by the precision of the stablecoin
    async totalCollateralRatio() : Promise<CollateralInfo> {
        return { collateralRatio: ((await this.totalDepositedCollateral()) as Decimal).div((new Decimal(this.borrowingMarketState.stablecoinBorrowed.toString())).div(STABLECOIN_DECIMALS)) } as CollateralInfo;
    }

    // calculates if the total collateral ratio brings the protocl into recovery mode
    // this increases the minimum collateral ratio!
    // this is linked to the health of the protocol
    async calculateSystemMode() : Promise<[SystemMode, BN | Decimal]> {
        const tcr = ((await this.totalCollateralRatio()).collateralRatio as Decimal).mul(new Decimal(100));
        // console.log(`tcr ${tcr.toNumber()}`);
        if ((tcr as Decimal).lt(new Decimal(150))) {
            return [SystemMode.Recovery, tcr];
        } else {
            return [SystemMode.Normal, tcr];
        }
    }

    // minimum collateral ratio is based on the protocol's health
    async calculateMcr() : Promise<BN | Decimal> {
        const [mode, _tcr] = await this.calculateSystemMode();
        if (SystemMode.Normal === mode) {
            return new Decimal(110);
        } else if (SystemMode.Recovery === mode) {
            return new Decimal(150);
        }
    }

    // retrieve all the associated token accounts (ATA) PublicKey of the liquidator running this bot
    // this really only needs to be run once
    getLiquidatorAssociatedTokenAccounts() : Promise<LiquidatorAssociatedTokenAccounts> {
        return new Promise((resolve) => {
            const liquidatorAssociatedTokenAccounts = {} as LiquidatorAssociatedTokenAccounts;
            const chunkOf5Tokens = chunk(Object.keys(this.clusterConfig.borrowing.accounts.mint), 5) as Array<Array<string>>;
            Promise.all(chunkOf5Tokens.map(async (chunkedTokens, chunkIndex) => {
                return await Promise.all(chunkedTokens.map(token => {
                    return new Promise((resolve) => {
                        setTimeout(async () => {
                            resolve({ token, pub: (await getAssociatedTokenAddress(new PublicKey(this.clusterConfig.borrowing.accounts.mint[token]), this.hubbleProgram.provider.wallet.publicKey)) });
                        }, 1000 * chunkIndex);
                    });
                }));
            })).then(tokenAddresses => {
                flat(tokenAddresses).forEach((ata: { token: string, pub: PublicKey }) => {
                    // mint uses WSOL for the key, while ActiveCollateralToken uses SOL ...
                    liquidatorAssociatedTokenAccounts[ata.token === 'WSOL' ? 'SOL' : ata.token] = ata.pub.toBase58();
                });
                resolve(liquidatorAssociatedTokenAccounts);
            });
        });
    }

    // async helper function for loading the Liquidator
    static async load(idl: Idl, configs: Array<Config>) : Promise<Liquidator>  {

        if (process.env.CLUSTER === undefined) {
            console.error('please add CLUSTER env variable to .env');
            process.exit();
        }

        if (process.env.RPC_URL === undefined) {
            console.error('please add RPC_URL env variable to .env');
            process.exit();
        }

        // load the config pertaining to the environment of the bot
        const clusterConfig = configs.find(c => c.env.toString() === (process.env.CLUSTER as Cluster).toString());
        
        // create the TPU Connection (will allow us to send more tx's to the tpu leaders (not rate limited))
        const connection = await TpuConnection.load(process.env.RPC_URL, { commitment: 'processed' });

        // wallet used as the liquidator and to sign/send transactions
        const wallet = getWallet();

        // create the Anchor Program for the HubbleProtocol on chain program
        const hubbleProgram = new Program(idl as Idl, new PublicKey(clusterConfig.borrowing.programId), new Provider(connection, wallet, {commitment: 'processed'}));

        // load borrowing market state
        const borrowingMarketState = (await hubbleProgram.account.borrowingMarketState.fetch(clusterConfig.borrowing.accounts.borrowingMarketState)) as BorrowingMarketState;
        // load liquidations queue
        const liquidationsQueue = (await hubbleProgram.account.liquidationsQueue.fetch(clusterConfig.borrowing.accounts.liquidationsQueue)) as LiquidationsQueue;
        // load initial blockhash
        const blockhash = (await hubbleProgram.provider.connection.getRecentBlockhash()).blockhash;
        
        return new Liquidator(
            process.env.CLUSTER as Cluster,
            idl, 
            configs, 
            clusterConfig, 
            wallet, 
            hubbleProgram, 
            borrowingMarketState,
            liquidationsQueue,
            blockhash
        );

    }

    constructor(cluster: Cluster, idl: Idl, configs: Array<Config>, clusterConfig: Config, wallet: Wallet, hubbleProgram: Program<Idl>, borrowingMarketState: BorrowingMarketState, liquidationsQueue: LiquidationsQueue, blockhash: string) {
        // add the helper variables to this instance of the Liquidator
        this.cluster = cluster;
        this.idl = idl;
        this.configs = configs;
        this.clusterConfig = clusterConfig;
        this.wallet = wallet;
        this.hubbleProgram = hubbleProgram;
        this.borrowingMarketState = borrowingMarketState;
        this.liquidationsQueue = liquidationsQueue;
        this.blockhash = blockhash;
        
        // init clearLiquidationGains map
        this.clearLiquidationGainsIXMap = new Map<string, TransactionInstruction>();

        // init liquidation map
        this.liquidationIXMap = new Map<string, TransactionInstruction>();

        // start loading the liquidator ATAs
        // and create the clear liquidation gains IX
        this.getLiquidatorAssociatedTokenAccounts().then(async liquidatorAssociatedTokenAccounts => {
            this.liquidatorAssociatedTokenAccounts = liquidatorAssociatedTokenAccounts;
            // for each active collateral token create a clear liquidation gains transaction instruction and save it to the map, since that will never change
            Object.keys(CollateralTokenActive).filter(token => isNaN(parseInt(token))).forEach(async tokenAccount => {
                this.clearLiquidationGainsIXMap.set(tokenAccount, await this.getClearLiquidationGainsIX(tokenAccount, new PublicKey(this.liquidatorAssociatedTokenAccounts[tokenAccount])));
            });
        });
        

        

        

        // minimum collateral ratio
        this.mcr = new Decimal(100);
        
        // create the polling accounts fetcher
        this.pollingAccountsFetcher = new PollingAccountsFetcher(500);

        // add the liquidations queue PublicKey to the polling accounts fetcher
        this.pollingAccountsFetcher.addProgram('liquidationsQueue', clusterConfig.borrowing.accounts.liquidationsQueue, this.hubbleProgram, (async (liquidationsQueue : LiquidationsQueue) => {
            this.liquidationsQueue = liquidationsQueue;

            // clear the liquidation queue
            await this.clearLiquidationQueue();
        }), (error => {
            console.error(error);
        }), this.liquidationsQueue);

        // add the borrowing market state PublicKey to the polling accounts fetcher
        this.pollingAccountsFetcher.addProgram('borrowingMarketState', clusterConfig.borrowing.accounts.borrowingMarketState, this.hubbleProgram, (async (borrowingMarketState : BorrowingMarketState) => {
            this.borrowingMarketState = borrowingMarketState;

            // will need to recalculate the minimum collateral ratio
            this.mcr = await this.calculateMcr();
        }), (error => {
            console.error(error);
        }), this.borrowingMarketState);
    

        // initiate the token prices object
        this.prices = {} as TokenPrices;

        // loop through the PriceInfo PublicKeys from the pyth object on the cluster config
        Object.keys(this.clusterConfig.borrowing.accounts.pyth).filter(key => key.includes('PriceInfo')).forEach(key => {

            // set prices to zero temporarily
            this.prices[key.split('Price')[0]] = { value: new Decimal(0), exp: new Decimal(0) };
            
            // add the PublicKey of the pyth oracle to the polling accounts fetcher
            // since the @pythnetwork/client doesn't have an anchor IDL which I can load into a program
            // instead this `addConstructAccount` will parse the price data returned from the rpc using `parsePriceData`
            this.pollingAccountsFetcher.addConstructAccount(this.clusterConfig.borrowing.accounts.pyth[key], (data: Buffer) => {
                return parsePriceData(data);
            }, async (priceData: PriceData) => {
                // sometimes the price/exponent is undefined because of the pyth oracle
                if (priceData.price && priceData.exponent) {
                    this.prices[key.split('Price')[0]] = { value: new Decimal(priceData.price), exp: new Decimal(priceData.exponent) };
                    // calculate the minimum collateral ratio whenever the price changes
                    this.mcr = await this.calculateMcr();
                } else {
                    console.log(`Pyth Oracle: ${priceData.productAccountKey.toBase58()} - ${Object.keys(this.clusterConfig.borrowing.accounts.pyth).map(key => ({ key, value: this.clusterConfig.borrowing.accounts.pyth[key] } )).find(keyValue => keyValue.value === priceData.productAccountKey.toBase58()).key.split("Pr")[0].toUpperCase()} - price ${PriceStatus[priceData.status]}`);
                }
            }, (error) => {
                console.error(error);
            });
        });
    }
}

// this is the account which the polling accounts fetcher will use
// fetch the accountPublicKey

export interface AccountToPoll<T> {
    data: T // the data 
    raw: string
    accountKey: string // account on the anchor program (used for decoding the buffer data returned by the rpc call)
    accountPublicKey: string
    program: Program<Idl>
    constructAccount: (buffer: Buffer) => any
    onFetch: (data: T) => void
    onError: (error: any) => void
}


export function chunk(array: Array<any>, chunk_size: number) : Array<any> {
    return new Array(Math.ceil(array.length / chunk_size)).fill(null).map((_, index) => index * chunk_size).map(begin => array.slice(begin, begin + chunk_size));
}

export function flat(arr: Array<any>, d = 1) : Array<any> {
    return d > 0 ? arr.reduce((acc, val) => acc.concat(Array.isArray(val) ? flat(val, d - 1) : val), []) : arr.slice();
}


class PollingAccountsFetcher {
    accounts: Map<string, AccountToPoll<any>>
    MAX_KEYS = 100
    frequency: number
    interval: NodeJS.Timer
    constructor(frequency: number) {
        this.frequency = frequency;
        this.accounts = new Map<string, AccountToPoll<any>>();
    }

    addProgram(accountKey: string, accountPublicKey: string, program: Program<Idl>, onFetch: (data: any) => void, onError: (error: any) => void, data?: any) {
        if (!this.accounts.has(accountPublicKey)) {
            this.accounts.set(accountPublicKey, { accountKey, accountPublicKey, program, onFetch, onError, data } as AccountToPoll<any>);
        }
    }

    addConstructAccount(accountPublicKey: string, constructAccount: (data: any) => any, onFetch: (data: any) => void, onError: (error: any) => void, data?: any) {
        if (!this.accounts.has(accountPublicKey)) {
            this.accounts.set(accountPublicKey, { accountPublicKey, constructAccount, onFetch, onError, data } as AccountToPoll<any>);
        }
    }

    start() {
        if(this.interval) {
            clearInterval(this.interval);   
        }
        this.interval = setInterval(() => {
            this.fetch();
        }, this.frequency);
    }

    stop() {
        if(this.interval) {
            clearInterval(this.interval);
        }
    }

    capitalize(value: string): string {
		return value[0].toUpperCase() + value.slice(1);
	}

    constructAccount(accountToPoll: AccountToPoll<any>, raw: string, dataType: BufferEncoding) : any {
        if (accountToPoll.program !== undefined) {
            return accountToPoll.program.account[
                accountToPoll.accountKey
            ].coder.accounts.decode(
                this.capitalize(accountToPoll.accountKey),
                Buffer.from(raw, dataType)
            );
        } else if (accountToPoll.constructAccount !== undefined) {
            return accountToPoll.constructAccount(Buffer.from(raw, dataType));
        }
        
    }

    axiosPost(requestChunk, retry = 0) : Promise<any> {
        return new Promise((resolve) => {
            const data = requestChunk.map(payload => 
                ({
                    jsonrpc: "2.0",
                    id: "1",
                    method: "getMultipleAccounts",
                    params: [
                        payload,
                        { commitment: "processed" },
                    ]
                })
            );
            axios.post(process.env.RPC_URL, data).then(response => {
                resolve(response.data);
            }).catch(error => {
                if (retry < 5) {
                    this.axiosPost(requestChunk, retry+1);
                } else {
                    console.error(error);
                    console.warn('failed to retrieve data 5 times in a row, aborting');
                }
            });
        });
    }

    async fetch() : Promise<void> {
        const accountValues = [...this.accounts.values()];
        // chunk accounts into groups of 100, 1 request can have 10 groups of 100, genesysgo can handle 10 requests a second (so we use 5 to not get rate limited)
        // this will handle 5k accounts every second :D
        const chunked = chunk(chunk(chunk(accountValues.map(x => x.accountPublicKey), this.MAX_KEYS), 10), 5);
        // const start = process.hrtime();
        const responses = flat(await Promise.all(chunked.map((request, index) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    Promise.all(request.map((requestChunk) => {
                        return this.axiosPost(requestChunk);
                    })).then(promisedResponses => {
                        resolve(flat(promisedResponses, Infinity));
                    });
                }, index * 1000);
            });
        })), Infinity);

        // const end = process.hrtime(start);
        // console.log(`took ${ ((end[0] * 1000) + (end[1] / 1000000)).toFixed(2) } ms to poll ${accountValues.length} accounts`);

        for(let x = 0; x < accountValues.length; x++) {
            const accountToPoll = accountValues[x];
            let accIndex = x;
            const responseIndex = Math.floor(accIndex / this.MAX_KEYS);
            const response = responses[responseIndex];
            while (accIndex >= this.MAX_KEYS) {
                accIndex -= this.MAX_KEYS;
            }
            try {
                if ((response as any).result.value[ accIndex ] !== null) {
                    const raw: string = (response as any).result.value[ accIndex ].data[0];
                    const dataType = (response as any).result.value[ accIndex ].data[1] as BufferEncoding;
                    const account = this.constructAccount(accountToPoll, raw, dataType);
                    if (accountToPoll.raw !== raw) {
                        accountToPoll.data = account;
                        accountToPoll.raw = raw;
                        accountToPoll.onFetch(account);
                    }
                } else {
                    console.warn(`account returned null: ${accountToPoll.accountPublicKey} - ${accountToPoll.accountKey}, removing!`);
                    this.accounts.delete(accountToPoll.accountPublicKey);
                }
                
            } catch (error) {
                // console.log(response, responseIndex, responses.length, accIndex, x, accountToPoll.accountKey, accountToPoll.accountPublicKey, accountToPoll.data);
                accountToPoll.onError(error);
            }
        }
    }
}

main();