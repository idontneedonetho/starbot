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
import { loadConfig } from '../config.js';

export async function handleIdentityButton(interaction: ButtonInteraction) {
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

  const nicknameInput = new TextInputBuilder({
    custom_id: 'identity_nickname',
    style: TextInputStyle.Short,
    placeholder: 'e.g. CoolPilot42',
    required: false,
    max_length: 24,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Nickname (optional)').setTextInputComponent(nicknameInput));

  await interaction.showModal(modal);
}

export async function handleIdentitySubmit(interaction: ModalSubmitInteraction) {
  const config = loadConfig();
  const nicknameRaw = interaction.fields.getTextInputValue('identity_nickname');
  const year = interaction.fields.getTextInputValue('identity_year');
  const model = interaction.fields.getTextInputValue('identity_model');

  if (!/^\d{4}$/.test(year)) {
    await interaction.reply({ content: 'Please enter a valid 4-digit year.', flags: MessageFlags.Ephemeral });
    return;
  }

  const baseName = (nicknameRaw || interaction.user.username).trim();
  const yearShort = year.slice(-2);
  const suffix = ` ('${yearShort} ${model})`;
  if (baseName.length + suffix.length > 32) {
    await interaction.reply({ content: 'Nickname + vehicle details too long for Discord (max 32 chars).', flags: MessageFlags.Ephemeral });
    return;
  }
  const nickname = `${baseName.slice(0, 32 - suffix.length)}${suffix}`;

  if (!(interaction.member instanceof GuildMember)) {
    await interaction.reply({ content: 'Could not identify your member record.', flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await interaction.member.setNickname(nickname);
  } catch {
    await interaction.reply({
      content: 'Failed to set nickname. Make sure the bot has **Manage Nicknames** permission and its role is above yours in the server settings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await interaction.member.roles.add(config.verifiedRole);
  } catch (err) {
    console.error('Failed to assign verified role:', err);
  }

  try {
    await interaction.member.roles.remove(config.pendingRole);
  } catch (err) {
    console.error('Failed to remove pending role:', err);
  }

  await interaction.reply({ content: `Nickname set to **${nickname}**`, flags: MessageFlags.Ephemeral });
}
