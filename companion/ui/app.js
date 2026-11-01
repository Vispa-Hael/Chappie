'use strict';

const bridge = window.chappie;
const byId = id => document.getElementById(id);
let current = null;
let pending = false;
let localError = '';
let localMessage = '';

function setOptions(select, items, selected, emptyLabel) {
  const normalized = items.length ? items : [{ id: '', name: emptyLabel }];
  const signature = JSON.stringify(normalized.map(item => [item.id, item.name]));
  if (select.dataset.options !== signature) {
    select.replaceChildren();
    for (const item of normalized) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      select.append(option);
    }
    select.dataset.options = signature;
  }
  if (normalized.some(item => item.id === selected)) select.value = selected;
}

function selectedGuild(state) {
  return state.guildId || (state.channels.length === 1 ? state.channels[0].guildId : '');
}

function render(value) {
  if (!value || typeof value !== 'object') return;
  const state = {
    phase: 'off', host: '', apps: [], outputs: [], channels: [], sharing: [], requests: [],
    app: '', privateOutput: 'DefaultRenderDevice', cableReady: false, ...value,
  };
  for (const key of ['apps', 'outputs', 'channels', 'sharing', 'requests']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  current = state;
  const sharing = state.phase === 'sharing';
  const transition = ['starting', 'stopping'].includes(state.phase);
  const busy = pending || transition;
  const paired = !!state.user;
  const guildId = selectedGuild(state);
  const broadcaster = state.sharing.find(item => item.guildId === guildId);
  const otherSharing = !!broadcaster && broadcaster.userId !== state.user?.id;
  const labels = {
    off: ['Off. Just for you.', paired ? 'Join voice in Discord, then flip the switch to share your music.' : 'Connect your Discord account to get started.'],
    pairing: ['Waiting for Discord.', 'Enter the pairing command below in Discord.'],
    starting: ['Turning on…', 'Routing your music and connecting to your voice channel.'],
    sharing: ['On. You’re sharing.', 'Your selected music app is playing for your Discord channel.'],
    stopping: ['Turning off…', 'Stopping your stream and restoring private listening.'],
    error: ['Needs your attention.', 'Check the message below, then try again.'],
  };
  const label = labels[state.phase] || ['Needs your attention.', 'Refresh your connection to continue.'];
  byId('phase').textContent = label[0];
  byId('description').textContent = label[1];
  document.body.classList.toggle('busy', busy);
  byId('toggle').setAttribute('aria-checked', String(sharing));
  byId('toggle').setAttribute('aria-label', sharing ? 'Turn Chappie off and restore private audio' : 'Turn Chappie on');
  byId('toggle').disabled = busy || (!sharing && (!paired || !state.cableReady || !state.app || !guildId || otherSharing));

  byId('source-name').textContent = state.apps.find(item => item.id === state.app)?.name || 'Choose your music app';
  const channel = state.channels.find(item => item.guildId === guildId);
  byId('destination').textContent = sharing
    ? `Sharing in ${channel ? `${channel.guildName} / ${channel.channelName}` : 'your Discord channel'}`
    : paired ? 'Ready when you are. Your headphones stay private while off.' : 'Connect your Discord account to get started.';
  const message = localError || state.error || localMessage || state.message || '';
  byId('message').textContent = message;
  byId('message').classList.toggle('error', !!(localError || state.error));

  byId('pair-card').hidden = paired;
  byId('pairing').hidden = !state.pairing;
  byId('pair-code').textContent = state.pairing ? `/pair ${state.pairing.code}` : '';
  if (state.pairing) {
    const expiry = new Date(state.pairing.expiresAt);
    byId('pair-expiry').textContent = Number.isFinite(expiry.getTime())
      ? `Code expires at ${expiry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'This code expires shortly.';
  }
  if (document.activeElement !== byId('host')) byId('host').value = state.host || '';
  byId('host').disabled = busy || sharing || !!state.pairing;
  byId('connect').disabled = busy || !!state.pairing;
  byId('connect').textContent = state.pairing ? 'Waiting for pairing…' : 'Connect Discord';
  byId('driver-card').hidden = state.cableReady;
  byId('driver-help').disabled = busy;

  setOptions(byId('app'), state.apps, state.app, 'Play audio, then refresh');
  const outputs = [{ id: 'DefaultRenderDevice', name: 'Normal Windows output (recommended)' },
    ...state.outputs.filter(output => output.id !== 'DefaultRenderDevice')];
  setOptions(byId('output'), outputs, state.privateOutput, 'No private output available');
  const channels = state.channels.map(item => ({ id: item.guildId, name: `${item.guildName} / ${item.channelName}` }));
  if (channels.length > 1 && !guildId) channels.unshift({ id: '', name: 'Choose your voice channel' });
  setOptions(byId('channel'), channels, guildId, paired ? 'Join a voice channel, then refresh' : 'Connect Discord first');
  byId('app').disabled = busy;
  for (const id of ['output', 'channel']) byId(id).disabled = busy || sharing;
  byId('refresh').disabled = busy;
  byId('disconnect').disabled = busy || !paired || sharing;
  byId('account').textContent = paired ? `Connected as ${state.user.name}. Your bot host never needs your Discord password.` : 'No Discord account connected.';
  byId('setup-note').textContent = sharing ? 'Switching music apps briefly reconnects Chappie. Turn it off to change headphones or voice channels.' : 'Start playing a little audio if your app is missing, then refresh. You can switch music apps while sharing.';

  byId('turn-card').hidden = !otherSharing;
  byId('turn-description').textContent = otherSharing ? `${broadcaster.userName || 'A friend'} is sharing in this server. Request a turn without interrupting their music.` : '';
  const requested = state.requests.some(item => item.guildId === guildId && item.userId === state.user?.id);
  byId('request-turn').textContent = requested ? 'Turn requested' : 'Request a turn';
  byId('request-turn').disabled = busy || requested || !paired;
  const requests = sharing ? state.requests.filter(item => item.guildId === guildId && item.userId !== state.user?.id) : [];
  byId('requests-card').hidden = !requests.length;
  const list = byId('requests');
  const requestSignature = JSON.stringify(requests.map(item => [item.userId, item.userName]));
  if (list.dataset.requests !== requestSignature) {
    list.replaceChildren();
    for (const request of requests) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = request.userName || 'A friend';
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'button'; button.textContent = 'Hand over';
      button.addEventListener('click', () => run(() => bridge.handoff(request.userId), 'Handing over your turn…'));
      item.append(name, button); list.append(item);
    }
    list.dataset.requests = requestSignature;
  }
  for (const button of list.querySelectorAll('button')) button.disabled = busy;
  if (!paired || !state.app || !guildId) byId('setup').open = true;
}

async function run(action, message = '') {
  if (pending) return;
  pending = true; localError = ''; localMessage = message;
  if (current) render(current);
  try {
    const state = await action();
    if (state && typeof state === 'object') render(state);
    else render(await bridge.state());
  } catch (error) {
    localError = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  } finally {
    pending = false; localMessage = '';
    if (current) render(current);
  }
}

if (!bridge) {
  byId('phase').textContent = 'Open the Chappie app.';
  byId('description').textContent = 'This interface works inside the installed Chappie Companion.';
  byId('message').textContent = 'Launch Chappie Companion from your Start menu.';
  for (const control of document.querySelectorAll('button, input, select')) control.disabled = true;
} else {
  byId('connect').addEventListener('click', () => {
    const host = byId('host').value.trim();
    return run(async () => {
      if (!host) throw new Error('Enter the Chappie host address shared with you first.');
      await bridge.configure({ host });
      return bridge.pair();
    }, 'Creating your Discord pairing code…');
  });
  byId('toggle').addEventListener('click', () => run(() => bridge.toggle()));
  byId('refresh').addEventListener('click', () => run(() => bridge.state(), 'Refreshing apps and channels…'));
  byId('app').addEventListener('change', () => { const app = byId('app').value; return run(() => bridge.configure({ app })); });
  byId('output').addEventListener('change', () => { const privateOutput = byId('output').value; return run(() => bridge.configure({ privateOutput })); });
  byId('channel').addEventListener('change', () => { const guildId = byId('channel').value; return run(() => bridge.configure({ guildId })); });
  byId('request-turn').addEventListener('click', () => run(() => bridge.requestTurn(), 'Requesting a turn…'));
  byId('disconnect').addEventListener('click', () => run(() => bridge.unpair(), 'Disconnecting your account…'));
  byId('driver-help').addEventListener('click', () => run(() => bridge.openDriverHelp()));
  bridge.onState(render);
  run(() => bridge.state());
}
