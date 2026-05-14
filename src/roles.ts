import type { Guild, GuildMember } from 'discord.js';

export function getAvailableMakeRoles(guild: Guild, ignoredRoles: string[]) {
  return [...guild.roles.cache.values()]
    .filter(r => !ignoredRoles.includes(r.name) && !r.managed && r.name !== '@everyone')
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function assignMakeRole(member: GuildMember, makeName: string, ignoredRoles: string[]): Promise<void> {
  const available = getAvailableMakeRoles(member.guild, ignoredRoles);
  const target = available.find(r => r.name === makeName);
  if (!target) return;

  const toRemove = available.filter(r => r.id !== target.id);
  await member.roles.remove(toRemove).catch(err => console.error('Failed to remove old make roles:', err));
  await member.roles.add(target).catch(err => console.error('Failed to assign make role:', err));
}
