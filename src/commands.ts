import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('pair').setDescription('Link your Chappie Companion using its short code.')
    .addStringOption(option => option.setName('code').setDescription('Code displayed in your companion app').setRequired(true).setMinLength(8).setMaxLength(8)),
  new SlashCommandBuilder().setName('unpair').setDescription('Revoke all companion devices linked to your Discord account.'),
  new SlashCommandBuilder().setName('join').setDescription('Bring the audio relay into your voice channel.'),
  new SlashCommandBuilder().setName('start').setDescription('Broadcast the configured Windows audio input.'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop broadcasting and release the recording device.'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop broadcasting and leave voice.'),
  new SlashCommandBuilder().setName('status').setDescription('Show the audio relay status.'),
  new SlashCommandBuilder().setName('volume').setDescription('Set relay volume without changing Windows volume.')
    .addIntegerOption(option => option.setName('percent').setDescription('Volume from 0 to 100').setMinValue(0).setMaxValue(100).setRequired(true)),
].map(command => command.setDMPermission(false).toJSON());
