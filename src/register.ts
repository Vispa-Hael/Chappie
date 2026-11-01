import { REST, Routes } from 'discord.js';
import { discordConfig } from './config.js';
import { commands } from './commands.js';

try {
  const config = discordConfig();
  const rest = new REST().setToken(config.token);
  await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
  // Remove the original server-specific commands so they do not shadow global ones.
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: [] });
  console.log('Registered global relay commands for all servers where Chappie is invited; removed original server overrides.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command registration failed.');
  process.exitCode = 1;
}
