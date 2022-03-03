# Typescript Liquidation Bot for HubbleProtocol by Lmvdzande


> TPU Client for sending tryLiquidate and clearLiquidationGains transactions without a rate limit  
> Polling Account Fetcher for account retrieval (5k accounts per second)  

copy the `.env.example` file to `.env` and input your `BOT_KEY` and `RPC_URL`  

`BOT_KEY` can be either an Uint8Array (solana-keygen) or bs58 encoded private key (phantom wallet private key export)  

```bash
yarn install
yarn build
yarn start
```
