import { GuildMember, type ModalSubmitInteraction } from 'discord.js';

export function getMemberDisplayName(interaction: ModalSubmitInteraction): string {
  return interaction.member instanceof GuildMember
    ? (interaction.member.nickname || interaction.user.displayName)
    : interaction.user.displayName;
}
