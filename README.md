# Typescript Liquidation Bot for HubbleProtocol by Lmvdzande


> TPU Client for sending tryLiquidate and clearLiquidationGains transactions without a rate limit  
> Polling Account Fetcher for account retrieval (5k accounts per second)  



### Overview

Liquidations on HubbleProtocol are as follows:

For a User to be liquidatable their Loan to Value (LTV) must reach 90.91 % (Under normal system conditions)  
The User gets liquidated via the `tryLiquidate` transaction instruction  
The Liquidatation gains get added to the LiquidationQueue  
The LiquidationQueue contains LiquidationEvents, new events in the queue having a pending status
The `clearLiquidationGains` transaction instruction is used to collect the gains from liquidation event  


### Environment

copy the `.env.example` file to `.env` and input your `BOT_KEY` and `RPC_URL`  

`BOT_KEY` can be either an Uint8Array (solana-keygen) or bs58 encoded private key (phantom wallet private key export)  

### Usage

```bash
yarn install
yarn build
yarn start
```
