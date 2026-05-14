import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  GuildMember,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { computeNickname } from '../nick.js';
import { loadConfig } from '../config.js';

const config = loadConfig();

export async function handleIdentityButton(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId('identity_modal')
    .setTitle('Set Your Nickname');

  const yearInput = new TextInputBuilder()
    .setCustomId('identity_year')
    .setLabel('Year')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 2024')
    .setRequired(true)
    .setMaxLength(4)
    .setMinLength(4);

  const modelInput = new TextInputBuilder()
    .setCustomId('identity_model')
    .setLabel('Model')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Bolt, Model 3, F-150')
    .setRequired(true)
    .setMaxLength(50);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(yearInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(modelInput),
  );

  await interaction.showModal(modal);
}

export async function handleIdentitySubmit(interaction: ModalSubmitInteraction) {
  const year = interaction.fields.getTextInputValue('identity_year');
  const model = interaction.fields.getTextInputValue('identity_model');

  const currentYear = new Date().getFullYear();
  const yearNum = Number(year);
  if (!/^\d{4}$/.test(year) || yearNum < currentYear - 15 || yearNum > currentYear) {
    await interaction.reply({ content: 'Please enter a valid year (last 15 years).', flags: MessageFlags.Ephemeral });
    return;
  }

  const username = interaction.user.username;
  const result = computeNickname(username, year, model);
  if (!result.valid) {
    await interaction.reply({ content: result.error ?? 'Invalid nickname.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!(interaction.member instanceof GuildMember)) {
    await interaction.reply({ content: 'Could not identify your member record.', flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await interaction.member.setNickname(result.nickname);
  } catch {
    await interaction.reply({
      content: 'Failed to set nickname. Make sure the bot has **Manage Nicknames** permission.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await interaction.member.roles.add(config.verifiedRole);
  } catch (err) {
    console.error('Failed to assign verified role:', err);
  }

  await interaction.reply({ content: `Nickname set to **${result.nickname}**`, flags: MessageFlags.Ephemeral });
}
