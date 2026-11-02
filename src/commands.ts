import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Bring the audio relay into your voice channel.'),
  new SlashCommandBuilder().setName('start').setDescription('Broadcast the configured Windows audio input.'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop broadcasting and release the recording device.'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop broadcasting and leave voice.'),
  new SlashCommandBuilder().setName('status').setDescription('Show the audio relay status.'),
  new SlashCommandBuilder().setName('volume').setDescription('Set relay volume without changing Windows volume.')
    .addIntegerOption(option => option.setName('percent').setDescription('Volume from 0 to 100').setMinValue(0).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('playpause').setDescription('Toggle play or pause in the Windows music app (host owner only).'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track in the Windows music app (host owner only).'),
  new SlashCommandBuilder().setName('rewind').setDescription('Restart or go to the previous track in the Windows music app (host owner only).'),
].map(command => command.setDMPermission(false).toJSON());
