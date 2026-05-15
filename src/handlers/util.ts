import { GuildMember, type Interaction } from 'discord.js';

export function getMemberDisplayName(interaction: Interaction): string {
  if (interaction.member instanceof GuildMember && interaction.member.nickname) {
    return interaction.member.nickname;
  }
  // Fall back to display name, then user tag (e.g., user#1234).
  return interaction.user.displayName || interaction.user.tag;
}
