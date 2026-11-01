import 'dotenv/config';

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return value;
}

export function discordConfig() {
  const id = (name: string) => {
    const value = required(name);
    if (!/^\d{17,20}$/.test(value)) throw new Error(`${name} must be a Discord ID (17–20 digits).`);
    return value;
  };
  return { token: required('DISCORD_TOKEN'), clientId: id('DISCORD_CLIENT_ID'),
    guildId: id('DISCORD_GUILD_ID'), ownerId: id('BOT_OWNER_ID') };
}
