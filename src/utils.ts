import { Wallet } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import * as bs58 from 'bs58';

import { config } from 'dotenv';
config();

export function getWallet(): Wallet {
	const botKeyEnvVariable = "BOT_KEY";
	// ENVIRONMENT VARIABLE FOR THE BOT PRIVATE KEY
	const botKey = process.env[botKeyEnvVariable];

	if (botKey === undefined) {
		console.error('need a ' + botKeyEnvVariable +' env variable');
		process.exit();
	}
	// setup wallet
	let keypair : Keypair;

	try {
		keypair = Keypair.fromSecretKey(
			bs58.decode(botKey)
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