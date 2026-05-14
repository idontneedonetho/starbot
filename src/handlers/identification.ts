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
import { getAvailableMakeRoles, assignMakeRole } from '../roles.js';
import { loadConfig } from '../config.js';

const config = loadConfig();

export async function handleIdentityButton(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId('identity_modal')
    .setTitle('Update Your Identity');

  const yearInput = new TextInputBuilder()
    .setCustomId('identity_year')
    .setLabel('Year')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 2024')
    .setRequired(true)
    .setMaxLength(4)
    .setMinLength(4);

  const makeInput = new TextInputBuilder()
    .setCustomId('identity_make')
    .setLabel('Make')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Tesla, Ford, Chevrolet')
    .setRequired(true)
    .setMaxLength(50);

  const modelInput = new TextInputBuilder()
    .setCustomId('identity_model')
    .setLabel('Model (Manual Entry)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Bolt, Model 3, F-150')
    .setRequired(true)
    .setMaxLength(50);

  const nameInput = new TextInputBuilder()
    .setCustomId('identity_name')
    .setLabel('Your First Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Jane')
    .setRequired(true)
    .setMaxLength(32);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(yearInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(makeInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(modelInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
  );

  await interaction.showModal(modal);
}

export async function handleIdentitySubmit(interaction: ModalSubmitInteraction) {
  const year = interaction.fields.getTextInputValue('identity_year');
  const make = interaction.fields.getTextInputValue('identity_make');
  const model = interaction.fields.getTextInputValue('identity_model');
  const name = interaction.fields.getTextInputValue('identity_name');

  const currentYear = new Date().getFullYear();
  const yearNum = Number(year);
  if (!/^\d{4}$/.test(year) || yearNum < currentYear - 15 || yearNum > currentYear) {
    await interaction.reply({ content: 'Please enter a valid year (last 15 years).', flags: MessageFlags.Ephemeral });
    return;
  }

  const makeRoles = getAvailableMakeRoles(interaction.guild!, config.ignoredRoles);
  const matchedRole = makeRoles.find(
    r => r.name.toLowerCase() === make.trim().toLowerCase(),
  );
  if (!matchedRole) {
    const names = makeRoles.map(r => `\`${r.name}\``).join(', ');
    await interaction.reply({
      content: `Make "${make}" not found. Available makes: ${names}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = computeNickname(name, year, matchedRole.name, model);
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

  await assignMakeRole(interaction.member, matchedRole.name, config.ignoredRoles);

  await interaction.reply({ content: `Identity updated to **${result.nickname}**`, flags: MessageFlags.Ephemeral });
}
