import { Bot } from './bot';

async function main() {
  const bot = await Bot.create();
  bot.start();
}

main();
