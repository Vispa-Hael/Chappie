import { REST, Routes } from 'discord.js';
import { discordConfig } from './config.js';
import { commands } from './commands.js';

try {
  const config = discordConfig();
  const rest = new REST().setToken(config.token);
  const guilds = await rest.get(Routes.userGuilds()) as { id: string }[];
  await Promise.all(guilds.map(guild => rest.put(Routes.applicationGuildCommands(config.clientId, guild.id), { body: commands })));
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  console.log(`Registered relay commands immediately in ${guilds.length} Chappie server(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command registration failed.');
  process.exitCode = 1;
}
