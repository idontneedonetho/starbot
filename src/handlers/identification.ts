import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  MessageFlags,
} from 'discord.js';
import type { BotConfig } from '../config.js';

export async function handleIdentityButton(_config: BotConfig, interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId('identity_modal')
    .setTitle('Set Your Nickname');

  const yearInput = new TextInputBuilder({
    custom_id: 'identity_year',
    style: TextInputStyle.Short,
    placeholder: 'e.g. 2024',
    required: true,
    max_length: 4,
    min_length: 4,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Year').setTextInputComponent(yearInput));

  const modelInput = new TextInputBuilder({
    custom_id: 'identity_model',
    style: TextInputStyle.Short,
    placeholder: 'e.g. Bolt, Model 3, F-150',
    required: true,
    max_length: 50,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Model').setTextInputComponent(modelInput));

  await interaction.showModal(modal);
}

export async function handleIdentitySubmit(config: BotConfig, interaction: ModalSubmitInteraction) {
  const year = interaction.fields.getTextInputValue('identity_year');
  const model = interaction.fields.getTextInputValue('identity_model');

  const currentYear = new Date().getFullYear();
  const yearNum = Number(year);
  if (!/^\d{4}$/.test(year) || yearNum < currentYear - 15 || yearNum > currentYear) {
    await interaction.reply({ content: 'Please enter a valid year (last 15 years).', flags: MessageFlags.Ephemeral });
    return;
  }

  const username = interaction.user.username;
  const yearShort = year.slice(-2);
  const suffix = ` ('${yearShort} ${model})`;
  if (suffix.length > 32) {
    await interaction.reply({ content: 'Vehicle details are too long for a Discord nickname.', flags: MessageFlags.Ephemeral });
    return;
  }
  const maxNameLen = 32 - suffix.length;
  const nickname = `${username.slice(0, maxNameLen)}${suffix}`;

  if (!(interaction.member instanceof GuildMember)) {
    await interaction.reply({ content: 'Could not identify your member record.', flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await interaction.member.setNickname(nickname);
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

  await interaction.reply({ content: `Nickname set to **${nickname}**`, flags: MessageFlags.Ephemeral });
}
