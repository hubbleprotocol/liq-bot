import { Idl } from '@project-serum/anchor';
import axios from 'axios';
import { Liquidator } from './liquidator';
import { Config } from './types';

//@ts-check
/**
 *
 * @returns {Promise<Idl>}
 */
async function getIDL(): Promise<Idl> {
  return (await axios.get('https://api.hubbleprotocol.io/idl')).data[0] as Idl;
}
//@ts-check
/**
 *
 * @returns {Promise<Array<Config>>}
 */
async function getConfigs(): Promise<Array<Config>> {
  return (await axios.get('https://api.hubbleprotocol.io/config'))
    .data as Array<Config>;
}

export class Bot {
  liquidator: Liquidator;
  intervals: Array<NodeJS.Timer>;

  //@ts-check
  /**
   *
   * @param liquidator {Liquidator}
   */
  constructor(liquidator: Liquidator) {
    this.liquidator = liquidator;
    this.intervals = new Array<NodeJS.Timer>();
  }

  //@ts-check
  /**
   *
   * @returns {Promise<Bot>}
   */
  static async create(): Promise<Bot> {
    // retrieve the IDL from https api
    const idl = await getIDL();
    // retrieve the configs from the https api
    const configs = await getConfigs();

    // use the static async function load instead of class constructor
    const liquidator = await Liquidator.load(idl, configs);

    return new Bot(liquidator);
  }

  //@ts-check
  /**
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    this.liquidator.pollingAccountsFetcher.stop();
    delete this.liquidator;
    await Promise.all(
      this.intervals.map((interval) => {
        clearInterval(interval);
      })
    );
    this.intervals = new Array<NodeJS.Timer>();
  }

  //@ts-check
  /**
   * @returns {Promise<void>}
   */
  async start(): Promise<void> {
    // check the idl and the configs for updates every minute
    this.intervals.push(
      setInterval(
        async function () {
          const idl = await getIDL();
          const configs = await getConfigs();

          const bot = this as Bot;

          if (
            JSON.stringify(bot.liquidator.idl) !== JSON.stringify(idl) &&
            JSON.stringify(bot.liquidator.configs) !== JSON.stringify(configs)
          ) {
            bot.stop();
            bot.liquidator = await Liquidator.load(idl, configs);
            bot.start();
          }
        }.bind(this as Bot),
        60 * 1000
      )
    );

    // load all the current users into the liquidator & account fetcher
    await this.liquidator.getUserMetadatas();

    // start the account fetcher (will update the users, market state, token prices, and any account which you throw at it)
    this.liquidator.pollingAccountsFetcher.start();

    // try to liquidate users every half second
    this.intervals.push(
      setInterval(
        async function () {
          this.liquidator.tryLiquidateUsers();
        }.bind(this as Bot),
        0.5 * 1000 // miliseconds
      )
    );

    // get new users every 30 seconds
    this.intervals.push(
      setInterval(
        async function () {
          this.liquidator.getUserMetadatas();
        }.bind(this as Bot),
        30 * 1000 // miliseconds
      )
    );
  }
}
