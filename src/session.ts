import { ChannelType, PermissionFlagsBits, type ChatInputCommandInteraction, type Client, type VoiceState, type Guild } from 'discord.js';
import { AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus,
  createAudioPlayer, entersState, joinVoiceChannel,
  type AudioResource, type VoiceConnection } from '@discordjs/voice';
import { Capture, listDevices } from './capture.js';
import { createMusicResource } from './audio.js';
import { attachDucking } from './ducking.js';

/** All mutable playback state belongs to one guild. */
export class RelaySession {
  readonly player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  connection?: VoiceConnection;
  capture?: Capture;
  resource?: AudioResource;
  emptyTimer?: NodeJS.Timeout;
  busy = false;
  lastFailure = '';
  private ducking?: ReturnType<typeof attachDucking>;
  private duckGain = 1;
  get broadcasting() { return !!this.capture; }
  constructor(readonly guildId: string, readonly client: Client, readonly device: string,
    public volume: number, readonly emptyTimeout: number) {
    this.player.on('error', error => {
      console.error(`[${this.guildId}] Audio player: ${error.message}`);
      this.lastFailure = 'Audio player failed. Check the local console, then use /start again.';
      this.stopAudio();
    });
    this.player.on(AudioPlayerStatus.Idle, () => { if (this.broadcasting) this.stopAudio(); });
  }
  stopAudio() {
    const old = this.capture;
    this.capture = undefined;
    this.resource = undefined;
    old?.stop();
    this.player.stop(true);
  }
  leave() {
    clearTimeout(this.emptyTimer);
    this.emptyTimer = undefined;
    this.stopAudio();
    this.ducking?.dispose();
    this.ducking = undefined;
    this.duckGain = 1;
    const old = this.connection;
    this.connection = undefined;
    if (old && old.state.status !== VoiceConnectionStatus.Destroyed) old.destroy();
  }
  updateEmptyTimer() {
    const channel = this.client.guilds.cache.get(this.guildId)?.channels.cache.get(this.connection?.joinConfig.channelId ?? '');
    if (!this.connection || !channel?.isVoiceBased() || channel.members.some(member => !member.user.bot)) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = undefined;
    } else if (!this.emptyTimer) {
      this.emptyTimer = setTimeout(() => { console.log(`[${this.guildId}] Empty channel; leaving.`); this.leave(); }, this.emptyTimeout);
    }
  }
  voiceStateChanged(state: VoiceState) {
    if (state.guild.id !== this.guildId) return;
    if (state.channelId !== this.connection?.joinConfig.channelId || state.serverMute || state.selfMute) this.ducking?.remove(state.id);
    if (state.id === this.client.user?.id && this.connection) {
      if (!state.channelId || state.channelId !== this.connection.joinConfig.channelId) {
        this.lastFailure = 'Bot was disconnected or moved. Use /start to join again.';
        this.leave();
      } else if (state.serverMute) {
        this.lastFailure = 'Bot was server-muted. Unmute it before using /start.';
        this.stopAudio();
      }
    }
    this.updateEmptyTimer();
  }
  async join(interaction: ChatInputCommandInteraction) {
    return this.joinOwner(interaction.guild!, interaction.user.id);
  }
  async joinOwner(guild: Guild, ownerId: string) {
    const member = await guild.members.fetch(ownerId);
    const channel = member.voice.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('Join a regular server voice channel first.');
    if (this.connection && this.connection.joinConfig.channelId !== channel.id) throw new Error('Use /leave from the current bot channel before moving it.');
    if (this.connection?.state.status === VoiceConnectionStatus.Ready) return;
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new Error('The bot needs View Channel, Connect, and Speak permissions in your voice channel.');
    }
    const next = joinVoiceChannel({ channelId: channel.id, guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    this.connection = next;
    const disconnected = new AbortController();
    const cancelConnection = () => disconnected.abort();
    next.once(VoiceConnectionStatus.Destroyed, cancelConnection);
    this.ducking?.dispose();
    this.ducking = attachDucking(next, id => {
      const member = guild.members.cache.get(id);
      return !!member && !member.user.bot && member.voice.channelId === next.joinConfig.channelId
        && !member.voice.serverMute && !member.voice.selfMute;
    }, gain => {
      this.duckGain = gain;
      this.resource?.volume?.setVolume(this.volume / 100 * gain);
    });
    next.on('stateChange', (_old, state) => {
      if (this.connection !== next) return;
      if (state.status === VoiceConnectionStatus.Disconnected || state.status === VoiceConnectionStatus.Destroyed) {
        this.lastFailure = 'Voice connection ended. Use /start to reconnect.';
        this.leave();
      }
    });
    try {
      await entersState(next, VoiceConnectionStatus.Ready, AbortSignal.any([AbortSignal.timeout(20_000), disconnected.signal]));
      if (this.connection !== next) throw new Error('Interrupted.');
      next.subscribe(this.player);
      this.updateEmptyTimer();
    } catch {
      this.leave();
      throw new Error('Could not connect to voice. Check permissions and your network, then try again.');
    } finally { next.off(VoiceConnectionStatus.Destroyed, cancelConnection); }
  }
  async startAudio() {
    if (this.capture) return;
    const devices = await listDevices();
    if (!devices.includes(this.device)) throw new Error('Configured recording device was not found. Run npm run devices and update AUDIO_DEVICE.');
    if (this.connection?.state.status !== VoiceConnectionStatus.Ready) throw new Error('Voice disconnected before capture started. Try /start again.');
    this.lastFailure = '';
    const next = new Capture(this.device, error => {
      if (this.capture !== next) return;
      this.lastFailure = 'Audio capture failed. Check the local console and run npm run check-audio.';
      console.error(`[${this.guildId}] ${error.message}`);
      this.stopAudio();
    });
    this.capture = next;
    try {
      this.resource = createMusicResource(next.child.stdout, this.volume * this.duckGain);
      this.player.play(this.resource);
      await entersState(this.player, AudioPlayerStatus.Playing, 12_000);
      if (this.capture !== next || this.connection?.state.status !== VoiceConnectionStatus.Ready) throw new Error('Capture interrupted.');
    } catch {
      this.stopAudio();
      throw new Error('Audio did not start. Check the local console and run npm run check-audio.');
    }
  }
  async execute(interaction: ChatInputCommandInteraction): Promise<string> {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    if (interaction.commandName !== 'status') {
      if (!member.voice.channelId) throw new Error('Join a voice channel first.');
      if (this.connection && member.voice.channelId !== this.connection.joinConfig.channelId) throw new Error('Join the bot’s voice channel to control it.');
    }
    switch (interaction.commandName) {
      case 'join': await this.join(interaction); return 'Joined your voice channel. Use /start to broadcast.';
      case 'start':
        await this.join(interaction);
        if (interaction.guild!.members.me?.voice.serverMute) throw new Error('The bot is server-muted. Unmute it first.');
        await this.startAudio();
        return `Broadcasting your computer audio in this server at ${this.volume}%.`;
      case 'stop': this.stopAudio(); return 'Broadcast stopped in this server.';
      case 'leave': this.leave(); return 'Broadcast stopped; left voice in this server.';
      case 'volume': {
        const value = interaction.options.getInteger('percent', true);
        if (value < 0 || value > 100) throw new Error('Volume must be 0–100.');
        this.volume = value;
        this.resource?.volume?.setVolume(value / 100 * this.duckGain);
        return `Relay volume in this server is ${value}%.`;
      }
      case 'status': return `Voice: ${this.connection ? `<#${this.connection.joinConfig.channelId}> (${this.connection.state.status})` : 'disconnected'}\nBroadcast: ${this.broadcasting ? this.player.state.status : 'stopped'}\nVolume: ${this.volume}%${this.lastFailure ? `\n${this.lastFailure}` : ''}`;
      default: throw new Error('Unknown command. Run npm run register to refresh commands.');
    }
  }
}
