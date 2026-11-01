import { Client, GatewayIntentBits, MessageFlags, ChannelType } from 'discord.js';
import { boundedNumber, discordConfig, required } from './config.js';
import { RelaySession } from './session.js';
import { startPanel } from './panel.js';
import type { Server } from 'node:http';
import { createRemoteService } from './remote/service.js';

const config = discordConfig();
const device = required('AUDIO_DEVICE');
const defaultVolume = boundedNumber('DEFAULT_VOLUME', 50, 0, 100);
const emptyTimeout = boundedNumber('EMPTY_CHANNEL_TIMEOUT_SECONDS', 60, 5, 3600) * 1000;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map<string, RelaySession>();
let shuttingDown = false;
let panel: Server | undefined;
let remote: Awaited<ReturnType<typeof createRemoteService>> | undefined;
const remoteStarts = new Map<string, import('node:stream').PassThrough>();
function sessionFor(guildId: string) {
  let session = sessions.get(guildId);
  if (!session) { session = new RelaySession(guildId, client, device, defaultVolume, emptyTimeout); sessions.set(guildId, session); }
  return session;
}

client.on('voiceStateUpdate', (_old, state) => sessions.get(state.guild.id)?.voiceStateChanged(state));
client.on('guildDelete', guild => { sessions.get(guild.id)?.leave(); sessions.delete(guild.id); });
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!interaction.inGuild() || interaction.user.bot) return;
    if (interaction.commandName === 'pair') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!remote) throw new Error('Companion pairing is not available yet.');
      await remote.approvePair(interaction.options.getString('code', true).trim(), interaction.user.id, interaction.user.displayName);
      await interaction.editReply('Your companion is linked. Return to the app, join voice, and switch Chappie on. Only enter codes from your own app.');
      return;
    }
    if (interaction.commandName === 'unpair') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await remote?.revokeUser(interaction.user.id);
      await interaction.editReply('Your companion devices were revoked. Pair again to share.');
      return;
    }
    const owner = interaction.user.id === config.ownerId;
    if (!owner && !remote?.isPaired(interaction.user.id)) {
      await interaction.reply({ content: 'Pair your Chappie Companion first using /pair and the code shown in your app.', flags: MessageFlags.Ephemeral });
      return;
    }
    const session = sessionFor(interaction.guildId);
    const lease = remote?.getGuildLease(interaction.guildId);
    if (interaction.commandName !== 'status' && !owner && ((lease && lease.userId !== interaction.user.id) || (!lease && session.broadcasting))) {
      await interaction.reply({ content: 'Someone else is sharing. Request a turn in your companion app.', flags: MessageFlags.Ephemeral }); return;
    }
    if (session.busy) {
      await interaction.reply({ content: 'The previous command in this server is still finishing. Try again in a moment.', flags: MessageFlags.Ephemeral });
      return;
    }
    session.busy = true;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (['stop', 'leave'].includes(interaction.commandName) && lease) {
        const member = await interaction.guild!.members.fetch(interaction.user.id);
        if (!member.voice.channelId || member.voice.channelId !== session.connection?.joinConfig.channelId) throw new Error('Join Chappie’s voice channel first.');
        await remote!.stopGuild(interaction.guildId);
      }
      if (!owner && ['join', 'start'].includes(interaction.commandName)) {
        await session.join(interaction);
        await interaction.editReply('Chappie joined you. Switch On in your companion app to share your own audio.');
      } else {
        if (interaction.commandName === 'start' && lease) throw new Error('A companion is already sharing. Use /stop first to end it.');
        await interaction.editReply(await session.execute(interaction));
      }
    } finally { session.busy = false; }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed.';
    console.error(message);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(message.slice(0, 1800));
      else await interaction.reply({ content: message.slice(0, 1800), flags: MessageFlags.Ephemeral });
    } catch { console.error('Could not deliver the command response.'); }
  }
});
client.once('clientReady', async ready => {
  console.log(`Audio relay online as ${ready.user.tag}. Multi-server support enabled.`);
  try {
    remote = await createRemoteService({
      async context(userId) {
        const result = [];
        for (const guild of client.guilds.cache.values()) {
          const voice = guild.voiceStates.cache.get(userId);
          if (voice?.channel?.type !== ChannelType.GuildVoice) continue;
          const member = await guild.members.fetch(userId).catch(() => undefined);
          if (!member || member.user.bot) continue;
          result.push({ guildId: guild.id, guildName: guild.name, channelId: voice.channel.id, channelName: voice.channel.name });
        }
        return result;
      },
      async start(guildId, userId, pcm, onEnded) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) throw new Error('Chappie is not in that server.');
        const session = sessionFor(guildId);
        if (session.busy || session.broadcasting) throw new Error('Someone is already broadcasting in that server.');
        if (pcm.destroyed) throw new Error('The companion disconnected.');
        remoteStarts.set(guildId, pcm);
        const cancelled = new AbortController();
        const cancel = () => cancelled.abort();
        pcm.once('close', cancel);
        session.busy = true;
        try {
          await session.joinOwner(guild, userId, () => pcm.destroyed, cancelled.signal);
          if (pcm.destroyed) throw new Error('The companion disconnected.');
          if (guild.members.me?.voice.serverMute) throw new Error('Chappie is server-muted.');
          await session.startRemote(pcm, onEnded);
        } finally { pcm.off('close', cancel); session.busy = false; }
      },
      stop(guildId, pcm) {
        if (remoteStarts.get(guildId) !== pcm) return;
        remoteStarts.delete(guildId);
        sessions.get(guildId)?.leave();
      },
    });
  } catch (error) { console.error(`Remote sharing: ${(error as Error).message}`); }
  try {
    panel = await startPanel({
      async start() {
        const available = [...client.guilds.cache.values()].filter(guild => guild.voiceStates.cache.get(config.ownerId)?.channelId);
        if (!available.length) throw new Error('Join a Discord voice channel first, then turn Chappie on.');
        if (available.length > 1) throw new Error('Your account is connected to more than one server. Leave the extra voice connections first.');
        const guild = available[0];
        if (remote?.hasGuildLease(guild.id)) throw new Error('A companion is sharing in this server. Request a turn in the companion app.');
        if ([...sessions.values()].some(session => session.busy)) throw new Error('A Discord command is still finishing. Try again.');
        for (const session of sessions.values()) if (!remote?.hasGuildLease(session.guildId)) session.leave();
        let session = sessions.get(guild.id);
        if (!session) { session = new RelaySession(guild.id, client, device, defaultVolume, emptyTimeout); sessions.set(guild.id, session); }
        if (session.busy) throw new Error('A Discord command is still finishing. Try again.');
        session.busy = true;
        try {
          await session.joinOwner(guild, config.ownerId);
          if (guild.members.me?.voice.serverMute) throw new Error('Chappie is server-muted. Unmute the bot first.');
          await session.startAudio();
          return `${guild.name} / ${guild.voiceStates.cache.get(config.ownerId)?.channel?.name ?? 'voice'}`;
        } finally { session.busy = false; }
      },
      stop() {
        if ([...sessions.values()].some(session => session.busy)) throw new Error('A Discord command is still finishing. Try again.');
        for (const session of sessions.values()) if (!remote?.hasGuildLease(session.guildId)) session.leave();
      },
      status() { return { broadcasting: [...sessions.values()].some(session => !!session.capture),
        channels: [...sessions.values()].filter(session => !!session.capture).map(session => client.guilds.cache.get(session.guildId)?.name ?? session.guildId) }; },
    });
  } catch (error) { console.error(`Control panel: ${(error as Error).message}`); }
});
client.on('error', error => console.error(`Discord client: ${error.message}`));
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const session of sessions.values()) session.leave();
  sessions.clear();
  panel?.close();
  void remote?.shutdown();
  client.destroy();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try { await client.login(config.token); }
catch { shutdown(); console.error('Discord login failed. Check DISCORD_TOKEN and your internet connection.'); process.exitCode = 1; }
