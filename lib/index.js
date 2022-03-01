"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.flat = exports.chunk = exports.Liquidator = exports.getMintFromConfig = void 0;
const anchor_1 = require("@project-serum/anchor");
const spl_token_1 = require("@solana/spl-token");
const web3_js_1 = require("@solana/web3.js");
const axios_1 = __importDefault(require("axios"));
const bs58 = __importStar(require("bs58"));
const types_1 = require("./types");
const tpuClient_1 = require("./tpuClient");
const client_1 = require("@pythnetwork/client");
const hubble_sdk_1 = require("@hubbleprotocol/hubble-sdk");
const decimal_js_1 = __importDefault(require("decimal.js"));
require('dotenv').config();
// get the IDL from the https API
async function getIDL() {
    return (await axios_1.default.get('https://api.hubbleprotocol.io/idl')).data[0];
}
async function getConfigs() {
    return (await axios_1.default.get('https://api.hubbleprotocol.io/config')).data;
}
function getMintFromConfig(config, coin) {
    return config.borrowing.accounts['liquidationRewardsVault' + coin[0].toUpperCase() + coin.substring(1).toLowerCase()];
}
exports.getMintFromConfig = getMintFromConfig;
function getWallet() {
    const botKeyEnvVariable = "BOT_KEY";
    // ENVIRONMENT VARIABLE FOR THE BOT PRIVATE KEY
    const botKey = process.env[botKeyEnvVariable];
    if (botKey === undefined) {
        console.error('need a ' + botKeyEnvVariable + ' env variable');
        process.exit();
    }
    // setup wallet
    let keypair;
    try {
        keypair = web3_js_1.Keypair.fromSecretKey(bs58.decode(botKey, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"));
    }
    catch {
        try {
            keypair = web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(botKey)));
        }
        catch {
            console.error('Failed to parse private key from Uint8Array (solana-keygen) and base58 encoded string (phantom wallet export)');
            process.exit();
        }
    }
    return new anchor_1.Wallet(keypair);
}
class Bot {
    constructor(liquidator) {
        this.liquidator = liquidator;
        this.intervals = new Array();
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
        this.intervals = new Array();
    }
    async start() {
        // check the idl and the configs for updates every minute
        this.intervals.push(setInterval(async function () {
            const idl = await getIDL();
            const configs = await getConfigs();
            const bot = this;
            if (JSON.stringify(bot.liquidator.idl) !== JSON.stringify(idl) && JSON.stringify(bot.liquidator.configs) !== JSON.stringify(configs)) {
                bot.stop();
                bot.liquidator = await Liquidator.load(idl, configs);
                bot.start();
            }
        }.bind(this), 60 * 1000));
        // load all the current users into the liquidator & account fetcher
        await this.liquidator.getUserMetadatas();
        // start the account fetcher (will update the users, market state, token prices, and any account which you throw at it)
        this.liquidator.pollingAccountsFetcher.start();
        // try to liquidate users every half second
        this.intervals.push(setInterval(async function () {
            this.liquidator.tryLiquidateUsers();
        }.bind(this), 1000));
        // get new users every 30 seconds
        this.intervals.push(setInterval(async function () {
            this.liquidator.getUserMetadatas();
        }.bind(this), 30 * 1000));
        // get a new blockhash every second
        this.intervals.push(setInterval(async function () {
            this.liquidator.blockhash = (await this.liquidator.hubbleProgram.provider.connection.getRecentBlockhash()).blockhash;
        }.bind(this), 1000));
    }
}
async function main() {
    try {
        const bot = await Bot.create();
        bot.start();
    }
    catch (error) {
        console.error(error);
    }
}
class Liquidator {
    constructor(cluster, idl, configs, clusterConfig, wallet, hubbleProgram, borrowingMarketState, liquidationsQueue, blockhash) {
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
        this.clearLiquidationGainsIXMap = new Map();
        // init liquidation map
        this.liquidationIXMap = new Map();
        // start loading the liquidator ATAs
        // and create the clear liquidation gains IX
        this.getLiquidatorAssociatedTokenAccounts().then(async (liquidatorAssociatedTokenAccounts) => {
            this.liquidatorAssociatedTokenAccounts = liquidatorAssociatedTokenAccounts;
            // for each active collateral token create a clear liquidation gains transaction instruction and save it to the map, since that will never change
            Object.keys(types_1.CollateralTokenActive).filter(token => isNaN(parseInt(token))).forEach(async (tokenAccount) => {
                this.clearLiquidationGainsIXMap.set(tokenAccount, await this.getClearLiquidationGainsIX(tokenAccount, new web3_js_1.PublicKey(this.liquidatorAssociatedTokenAccounts[tokenAccount])));
            });
        });
        // minimum collateral ratio
        this.mcr = new decimal_js_1.default(100);
        // create the polling accounts fetcher
        this.pollingAccountsFetcher = new PollingAccountsFetcher(500);
        // add the liquidations queue PublicKey to the polling accounts fetcher
        this.pollingAccountsFetcher.addProgram('liquidationsQueue', clusterConfig.borrowing.accounts.liquidationsQueue, this.hubbleProgram, (async (liquidationsQueue) => {
            this.liquidationsQueue = liquidationsQueue;
            // clear the liquidation queue
            await this.clearLiquidationQueue();
        }), (error => {
            console.error(error);
        }), this.liquidationsQueue);
        // add the borrowing market state PublicKey to the polling accounts fetcher
        this.pollingAccountsFetcher.addProgram('borrowingMarketState', clusterConfig.borrowing.accounts.borrowingMarketState, this.hubbleProgram, (async (borrowingMarketState) => {
            this.borrowingMarketState = borrowingMarketState;
            // will need to recalculate the minimum collateral ratio
            this.mcr = await this.calculateMcr();
        }), (error => {
            console.error(error);
        }), this.borrowingMarketState);
        // initiate the token prices object
        this.prices = {};
        // loop through the PriceInfo PublicKeys from the pyth object on the cluster config
        Object.keys(this.clusterConfig.borrowing.accounts.pyth).filter(key => key.includes('PriceInfo')).forEach(key => {
            // set prices to zero temporarily
            this.prices[key.split('Price')[0]] = { value: new decimal_js_1.default(0), exp: new decimal_js_1.default(0) };
            // add the PublicKey of the pyth oracle to the polling accounts fetcher
            // since the @pythnetwork/client doesn't have an anchor IDL which I can load into a program
            // instead this `addConstructAccount` will parse the price data returned from the rpc using `parsePriceData`
            this.pollingAccountsFetcher.addConstructAccount(this.clusterConfig.borrowing.accounts.pyth[key], (data) => {
                return (0, client_1.parsePriceData)(data);
            }, async (priceData) => {
                // sometimes the price/exponent is undefined because of the pyth oracle
                if (priceData.price && priceData.exponent) {
                    this.prices[key.split('Price')[0]] = { value: new decimal_js_1.default(priceData.price), exp: new decimal_js_1.default(priceData.exponent) };
                    // calculate the minimum collateral ratio whenever the price changes
                    this.mcr = await this.calculateMcr();
                }
                else {
                    console.log(`Pyth Oracle: ${priceData.productAccountKey.toBase58()} - ${Object.keys(this.clusterConfig.borrowing.accounts.pyth).map(key => ({ key, value: this.clusterConfig.borrowing.accounts.pyth[key] })).find(keyValue => keyValue.value === priceData.productAccountKey.toBase58()).key.split("Pr")[0].toUpperCase()} - price ${client_1.PriceStatus[priceData.status]}`);
                }
            }, (error) => {
                console.error(error);
            });
        });
    }
    // create the clearLiquidationGains TransactionInstruction for the liquidator running this bot
    // will need to be called for each token
    async getClearLiquidationGainsIX(token, clearerAassociatedTokenAccount) {
        const args = [types_1.CollateralTokenActive[token]];
        const keys = [
            {
                pubkey: this.hubbleProgram.provider.wallet.publicKey,
                isWritable: true,
                isSigner: true
            },
            {
                pubkey: clearerAassociatedTokenAccount,
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.borrowingMarketState),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.globalConfig),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.borrowingVaults),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.stabilityPoolState),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.stabilityVaults),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.liquidationsQueue),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.collateralVault[token]),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.collateralVaultsAuthority),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts['liquidationRewardsVault' + token[0] + token.substring(1).toLowerCase()]),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: spl_token_1.TOKEN_PROGRAM_ID,
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: web3_js_1.SYSVAR_CLOCK_PUBKEY,
                isWritable: false,
                isSigner: false
            }
        ];
        return new web3_js_1.TransactionInstruction({
            data: this.hubbleProgram.coder.instruction.encode('clearLiquidationGains', args),
            programId: this.hubbleProgram.programId,
            keys: keys
        });
    }
    // create the `tryLiquidate` TransactionInstruction for specified UserMetadata account
    async getTryLiquidateIX(userMetadata) {
        const args = [];
        const keys = [
            {
                pubkey: this.hubbleProgram.provider.wallet.publicKey,
                isWritable: true,
                isSigner: true
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.borrowingMarketState),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.globalConfig),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.stabilityPoolState),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: userMetadata,
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.epochToScaleToSum),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.stabilityVaults),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.borrowingVaults),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.liquidationsQueue),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.stablecoinMint),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.stablecoinMintAuthority),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.stablecoinStabilityPoolVault),
                isWritable: true,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.stablecoinStabilityPoolVaultAuthority),
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.oracleMappings),
                isWritable: false,
                isSigner: false
            },
        ].concat(...Object.keys(types_1.CollateralTokenActive).filter(token => isNaN(parseInt(token))).map(token => {
            return {
                pubkey: new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.pyth[token.toLowerCase() + 'PriceInfo']),
                isWritable: false,
                isSigner: false
            };
        })).concat(...[
            {
                pubkey: spl_token_1.TOKEN_PROGRAM_ID,
                isWritable: false,
                isSigner: false
            },
            {
                pubkey: web3_js_1.SYSVAR_CLOCK_PUBKEY,
                isWritable: false,
                isSigner: false
            }
        ]);
        return new web3_js_1.TransactionInstruction({
            data: this.hubbleProgram.coder.instruction.encode('tryLiquidate', args),
            programId: this.hubbleProgram.programId,
            keys: keys
        });
    }
    // clear the liquidation queue
    async clearLiquidationQueue() {
        // filter the liquidation queue for events which are pending collection
        const filteredLiquidationQueue = this.liquidationsQueue.events.filter(e => e.status.toNumber() === types_1.EventStatus.PendingCollection);
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
    async clearLiquidationGains() {
        const chunkOf5Tokens = chunk(Object.keys(types_1.CollateralTokenActive).filter(token => isNaN(parseInt(token))), 5);
        return flat(await Promise.all(chunkOf5Tokens.map(async (chunkedTokenAccounts, chunkIndex) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    const tx = new web3_js_1.Transaction();
                    chunkedTokenAccounts.forEach(async (tokenAccount) => {
                        tx.add(this.clearLiquidationGainsIXMap.get(types_1.CollateralTokenActive[tokenAccount]));
                    });
                    tx.feePayer = this.hubbleProgram.provider.wallet.publicKey;
                    tx.recentBlockhash = this.blockhash;
                    this.hubbleProgram.provider.wallet.signTransaction(tx).then(tx => {
                        this.hubbleProgram.provider.connection.sendRawTransaction(tx.serialize()).then(signature => {
                            resolve(signature);
                        });
                    });
                }, 1000 * chunkIndex);
            });
        })));
    }
    async getPendingDebt(user) {
        const diffStableRpt = new decimal_js_1.default(this.borrowingMarketState.stablecoinRewardPerToken.toString()).minus(new decimal_js_1.default(user.userStablecoinRewardPerToken.toString()));
        return user.status !== 1 || diffStableRpt.isZero()
            ? new decimal_js_1.default(0)
            : diffStableRpt.mul(new decimal_js_1.default(user.userStake.toString())).dividedBy(hubble_sdk_1.DECIMAL_FACTOR);
    }
    async calculateTotalDebt(user) {
        const pendingDebt = await this.getPendingDebt(user);
        return new decimal_js_1.default(user.borrowedStablecoin.toString()).plus(pendingDebt).dividedBy(new decimal_js_1.default(hubble_sdk_1.STABLECOIN_DECIMALS));
    }
    zeroCollateral() {
        const keys = Object.keys(this.borrowingMarketState.collateralRewardPerToken).filter(key => !Array.isArray(this.borrowingMarketState.collateralRewardPerToken[key]));
        const zeroCollateral = {};
        keys.forEach(key => {
            zeroCollateral[key] = new decimal_js_1.default(0);
        });
        return zeroCollateral;
    }
    mulFrac(collateralAmmounts, numerator, denominator) {
        Object.keys(collateralAmmounts).filter(key => Array.isArray(collateralAmmounts[key])).forEach(key => {
            collateralAmmounts[key] = collateralAmmounts[key].dividedBy(denominator).mul(numerator);
        });
        return collateralAmmounts;
    }
    // 
    async getPendingCollateral(user) {
        const diffCollRpt = this.zeroCollateral();
        Object.keys(this.borrowingMarketState.collateralRewardPerToken).filter(key => !Array.isArray(this.borrowingMarketState.collateralRewardPerToken[key])).forEach(key => {
            diffCollRpt[key] = this.borrowingMarketState.collateralRewardPerToken[key].sub(user.userCollateralRewardPerToken[key]);
        });
        return user.status !== 1 || !Object.keys(diffCollRpt).some(key => !diffCollRpt[key].isZero())
            ? this.zeroCollateral()
            : this.mulFrac(diffCollRpt, new decimal_js_1.default(user.userStake.toString()), hubble_sdk_1.DECIMAL_FACTOR);
    }
    async addCollateralAmounts(collateralAmounts) {
        const keys = Object.keys(collateralAmounts[0]).filter(key => !Array.isArray(collateralAmounts[0][key]));
        return collateralAmounts.reduce((a, b) => {
            keys.forEach(key => {
                a[key] = a[key].plus(b[key]);
            });
            return a;
        }, this.zeroCollateral());
    }
    precisionFromKey(key) {
        switch (key) {
            case 'sol': return new decimal_js_1.default(hubble_sdk_1.LAMPORTS_PER_SOL);
            case 'btc': return new decimal_js_1.default(hubble_sdk_1.DECIMALS_BTC);
            case 'msol': return new decimal_js_1.default(hubble_sdk_1.LAMPORTS_PER_MSOL);
            case 'ray': return new decimal_js_1.default(hubble_sdk_1.DECIMALS_RAY);
            case 'ftt': return new decimal_js_1.default(hubble_sdk_1.DECIMALS_FTT);
            case 'eth': return new decimal_js_1.default(hubble_sdk_1.DECIMALS_ETH);
            case 'srm': return new decimal_js_1.default(hubble_sdk_1.DECIMALS_SRM);
        }
        return new decimal_js_1.default(1);
    }
    lamportsToDecimal(collateralAmounts) {
        // create a new collateral amounts object to avoid modifying the data associated with the user metadata
        const newCollateralAmounts = {};
        // filter through the collateral amounts parameter and divide by the precision based on the asset
        Object.keys(collateralAmounts).filter(key => !Array.isArray(collateralAmounts[key])).forEach(key => {
            newCollateralAmounts[key] = new decimal_js_1.default(collateralAmounts[key].toString()).div(this.precisionFromKey(key));
        });
        return newCollateralAmounts;
    }
    // add together deposited collateral, inactive collateral and pending collateral for the specified UserMetadata
    async calculateTotalCollateral(user) {
        return await this.addCollateralAmounts([this.lamportsToDecimal(user.depositedCollateral), this.lamportsToDecimal(user.inactiveCollateral), this.lamportsToDecimal(await this.getPendingCollateral(user))]);
    }
    // calculate the loans associated with each UserMetadata in the array
    // sum(collateral * price) / debt
    // divided by 100 to get the ratio 
    async getLoans(metadatas) {
        return (await Promise.all(metadatas.filter(metadata => new decimal_js_1.default(metadata.borrowedStablecoin.toString()).gt(new decimal_js_1.default(0))).map(async (metadata) => {
            return {
                metadata,
                usdhDebt: await this.calculateTotalDebt(metadata),
                collateral: await this.calculateTotalCollateral(metadata)
            };
        }))).map((loan) => {
            return {
                ...loan,
                tcr: Object.keys(loan.collateral).filter(key => !Array.isArray(loan.collateral[key])).map(key => (new decimal_js_1.default(loan.collateral[key].toString())).mul(this.prices[key].value)).reduce((a, b) => a.plus(b), new decimal_js_1.default(0)).div((new decimal_js_1.default(loan.usdhDebt.toString()))).mul(new decimal_js_1.default(100))
            };
        });
    }
    // get the loans for each userMetadata
    async tryLiquidateUsers() {
        // get loan (tcr) associated with each user metadata
        // filter for the account data from the polling account fetcher which have userMetadata as the accountKey
        // this will save the most RAM since these accounts are going to be taking up the most of the accounts memory allocation
        const loans = await this.getLoans([...this.pollingAccountsFetcher.accounts.values()].filter(acc => acc.accountKey === 'userMetadata').map(acc => acc.data));
        // loop through each loan and try to liquidate
        const sortedLoans = loans.sort((loanA, loanB) => loanA.tcr.toNumber() - loanB.tcr.toNumber());
        // const topLoan = sortedLoans[0];
        // if (!(topLoan.tcr as Decimal).eq(new Decimal(0))) {
        //     console.log(`${topLoan.metadata.metadataPk.toBase58()} - ${(1/(topLoan.tcr.toNumber()/100) * 100).toFixed(2)} %`);
        // }
        sortedLoans.forEach(async (loan) => {
            // initially all loan tcr's will be ZERO
            if (!loan.tcr.eq(new decimal_js_1.default(0))) {
                const mcrRange = this.mcr.plus(new decimal_js_1.default(10 * 0.0001));
                const liquidatable = loan.tcr.lt(mcrRange);
                const ltv = 1 / (loan.tcr.toNumber() / 100);
                // console.log(`liquidatable ${liquidatable} - mcr ${mcrRange.toNumber()} - tcr: ${loan.tcr.toNumber().toFixed(2)} - ltv ${(ltv * 100).toFixed(2)}`);
                if (liquidatable) {
                    console.log(`${loan.metadata.metadataPk.toBase58()} has ltv ${(ltv * 100).toFixed(2)} attempting to liquidate`);
                    let tx = new web3_js_1.Transaction().add(this.liquidationIXMap.get(loan.metadata.metadataPk.toBase58()));
                    tx.recentBlockhash = this.blockhash;
                    tx.feePayer = this.hubbleProgram.provider.wallet.publicKey;
                    tx = await this.hubbleProgram.provider.wallet.signTransaction(tx);
                    this.hubbleProgram.provider.connection.sendRawTransaction(tx.serialize());
                }
            }
        });
    }
    async getUserMetadatas() {
        // retrieve all the user metadatas from on chain
        const userMetadataProgramAccounts = (await this.hubbleProgram.account.userMetadata.all());
        // loop through all the metadata and load new ones 
        let usersLoaded = 0;
        (await Promise.all(userMetadataProgramAccounts.map(async (programAccount) => {
            if (!this.pollingAccountsFetcher.accounts.has(programAccount.account.metadataPk.toBase58()) && programAccount.account.borrowingMarketState.toBase58() === this.clusterConfig.borrowing.accounts.borrowingMarketState) {
                // add the userMetadata account to the polling account fetcher
                // preload the programAccount data to the polling accounts fetcher
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                this.pollingAccountsFetcher.addProgram('userMetadata', programAccount.account.metadataPk.toBase58(), this.hubbleProgram, (userMetadata) => {
                    // check if this user metadata is from an old config
                    // remove from the polling accounts fetcher
                    if (userMetadata.borrowingMarketState.toBase58() !== this.clusterConfig.borrowing.accounts.borrowingMarketState) {
                        console.log(`removing ${userMetadata.metadataPk.toBase58()} from the polling account fetcher because of difference in market state key`);
                        this.pollingAccountsFetcher.accounts.delete(userMetadata.metadataPk.toBase58());
                    }
                }, (error) => { console.error(error); }, programAccount.account);
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
    async totalDepositedCollateral() {
        return Object.keys(this.borrowingMarketState.depositedCollateral).filter(key => !Array.isArray(this.borrowingMarketState.depositedCollateral[key])).map(key => {
            return new decimal_js_1.default(this.borrowingMarketState.depositedCollateral[key].toString()).div(this.precisionFromKey(key)).mul(this.prices[key].value);
        }).reduce((a, b) => a.plus(b), new decimal_js_1.default(0));
    }
    // loop through the protocol deposited collateral for each token, multiple by the price and divide by the precision of the collateral asset
    // divide by the amount of borrowed stablecoin (usdh) and divide by the precision of the stablecoin
    async totalCollateralRatio() {
        return { collateralRatio: (await this.totalDepositedCollateral()).div((new decimal_js_1.default(this.borrowingMarketState.stablecoinBorrowed.toString())).div(hubble_sdk_1.STABLECOIN_DECIMALS)) };
    }
    // calculates if the total collateral ratio brings the protocl into recovery mode
    // this increases the minimum collateral ratio!
    // this is linked to the health of the protocol
    async calculateSystemMode() {
        const tcr = (await this.totalCollateralRatio()).collateralRatio.mul(new decimal_js_1.default(100));
        // console.log(`tcr ${tcr.toNumber()}`);
        if (tcr.lt(new decimal_js_1.default(150))) {
            return [types_1.SystemMode.Recovery, tcr];
        }
        else {
            return [types_1.SystemMode.Normal, tcr];
        }
    }
    // minimum collateral ratio is based on the protocol's health
    async calculateMcr() {
        const [mode, _tcr] = await this.calculateSystemMode();
        if (types_1.SystemMode.Normal === mode) {
            return new decimal_js_1.default(110);
        }
        else if (types_1.SystemMode.Recovery === mode) {
            return new decimal_js_1.default(150);
        }
    }
    // retrieve all the associated token accounts (ATA) PublicKey of the liquidator running this bot
    // this really only needs to be run once
    getLiquidatorAssociatedTokenAccounts() {
        return new Promise((resolve) => {
            const liquidatorAssociatedTokenAccounts = {};
            const chunkOf5Tokens = chunk(Object.keys(this.clusterConfig.borrowing.accounts.mint), 5);
            Promise.all(chunkOf5Tokens.map(async (chunkedTokens, chunkIndex) => {
                return await Promise.all(chunkedTokens.map(token => {
                    return new Promise((resolve) => {
                        setTimeout(async () => {
                            resolve({ token, pub: (await (0, spl_token_1.getAssociatedTokenAddress)(new web3_js_1.PublicKey(this.clusterConfig.borrowing.accounts.mint[token]), this.hubbleProgram.provider.wallet.publicKey)) });
                        }, 1000 * chunkIndex);
                    });
                }));
            })).then(tokenAddresses => {
                flat(tokenAddresses).forEach((ata) => {
                    // mint uses WSOL for the key, while ActiveCollateralToken uses SOL ...
                    liquidatorAssociatedTokenAccounts[ata.token === 'WSOL' ? 'SOL' : ata.token] = ata.pub.toBase58();
                });
                resolve(liquidatorAssociatedTokenAccounts);
            });
        });
    }
    // async helper function for loading the Liquidator
    static async load(idl, configs) {
        if (process.env.CLUSTER === undefined) {
            console.error('please add CLUSTER env variable to .env');
            process.exit();
        }
        if (process.env.RPC_URL === undefined) {
            console.error('please add RPC_URL env variable to .env');
            process.exit();
        }
        // load the config pertaining to the environment of the bot
        const clusterConfig = configs.find(c => c.env.toString() === process.env.CLUSTER.toString());
        // create the TPU Connection (will allow us to send more tx's to the tpu leaders (not rate limited))
        const connection = await tpuClient_1.TpuConnection.load(process.env.RPC_URL, { commitment: 'processed' });
        // wallet used as the liquidator and to sign/send transactions
        const wallet = getWallet();
        // create the Anchor Program for the HubbleProtocol on chain program
        const hubbleProgram = new anchor_1.Program(idl, new web3_js_1.PublicKey(clusterConfig.borrowing.programId), new anchor_1.Provider(connection, wallet, { commitment: 'processed' }));
        // load borrowing market state
        const borrowingMarketState = (await hubbleProgram.account.borrowingMarketState.fetch(clusterConfig.borrowing.accounts.borrowingMarketState));
        // load liquidations queue
        const liquidationsQueue = (await hubbleProgram.account.liquidationsQueue.fetch(clusterConfig.borrowing.accounts.liquidationsQueue));
        // load initial blockhash
        const blockhash = (await hubbleProgram.provider.connection.getRecentBlockhash()).blockhash;
        return new Liquidator(process.env.CLUSTER, idl, configs, clusterConfig, wallet, hubbleProgram, borrowingMarketState, liquidationsQueue, blockhash);
    }
}
exports.Liquidator = Liquidator;
function chunk(array, chunk_size) {
    return new Array(Math.ceil(array.length / chunk_size)).fill(null).map((_, index) => index * chunk_size).map(begin => array.slice(begin, begin + chunk_size));
}
exports.chunk = chunk;
function flat(arr, d = 1) {
    return d > 0 ? arr.reduce((acc, val) => acc.concat(Array.isArray(val) ? flat(val, d - 1) : val), []) : arr.slice();
}
exports.flat = flat;
class PollingAccountsFetcher {
    constructor(frequency) {
        this.MAX_KEYS = 100;
        this.frequency = frequency;
        this.accounts = new Map();
    }
    addProgram(accountKey, accountPublicKey, program, onFetch, onError, data) {
        if (!this.accounts.has(accountPublicKey)) {
            this.accounts.set(accountPublicKey, { accountKey, accountPublicKey, program, onFetch, onError, data });
        }
    }
    addConstructAccount(accountPublicKey, constructAccount, onFetch, onError, data) {
        if (!this.accounts.has(accountPublicKey)) {
            this.accounts.set(accountPublicKey, { accountPublicKey, constructAccount, onFetch, onError, data });
        }
    }
    start() {
        if (this.interval) {
            clearInterval(this.interval);
        }
        this.interval = setInterval(() => {
            this.fetch();
        }, this.frequency);
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
        }
    }
    capitalize(value) {
        return value[0].toUpperCase() + value.slice(1);
    }
    constructAccount(accountToPoll, raw, dataType) {
        if (accountToPoll.program !== undefined) {
            return accountToPoll.program.account[accountToPoll.accountKey].coder.accounts.decode(this.capitalize(accountToPoll.accountKey), Buffer.from(raw, dataType));
        }
        else if (accountToPoll.constructAccount !== undefined) {
            return accountToPoll.constructAccount(Buffer.from(raw, dataType));
        }
    }
    axiosPost(requestChunk, retry = 0) {
        return new Promise((resolve) => {
            const data = requestChunk.map(payload => ({
                jsonrpc: "2.0",
                id: "1",
                method: "getMultipleAccounts",
                params: [
                    payload,
                    { commitment: "processed" },
                ]
            }));
            axios_1.default.post(process.env.RPC_URL, data).then(response => {
                resolve(response.data);
            }).catch(error => {
                if (retry < 5) {
                    this.axiosPost(requestChunk, retry + 1);
                }
                else {
                    console.error(error);
                    console.warn('failed to retrieve data 5 times in a row, aborting');
                }
            });
        });
    }
    async fetch() {
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
        for (let x = 0; x < accountValues.length; x++) {
            const accountToPoll = accountValues[x];
            let accIndex = x;
            const responseIndex = Math.floor(accIndex / this.MAX_KEYS);
            const response = responses[responseIndex];
            while (accIndex >= this.MAX_KEYS) {
                accIndex -= this.MAX_KEYS;
            }
            try {
                if (response.result.value[accIndex] !== null) {
                    const raw = response.result.value[accIndex].data[0];
                    const dataType = response.result.value[accIndex].data[1];
                    const account = this.constructAccount(accountToPoll, raw, dataType);
                    if (accountToPoll.raw !== raw) {
                        accountToPoll.data = account;
                        accountToPoll.raw = raw;
                        accountToPoll.onFetch(account);
                    }
                }
                else {
                    console.warn(`account returned null: ${accountToPoll.accountPublicKey} - ${accountToPoll.accountKey}, removing!`);
                    this.accounts.delete(accountToPoll.accountPublicKey);
                }
            }
            catch (error) {
                // console.log(response, responseIndex, responses.length, accIndex, x, accountToPoll.accountKey, accountToPoll.accountPublicKey, accountToPoll.data);
                accountToPoll.onError(error);
            }
        }
    }
}
main();
//# sourceMappingURL=index.js.map