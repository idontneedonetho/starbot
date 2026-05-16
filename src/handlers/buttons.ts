import { Discord, ButtonComponent } from 'discordx';
import { type ButtonInteraction } from 'discord.js';
import { handleIdentityButton } from './identification.js';
import { handleReportButton, handleConfirmRoute } from './report.js';

@Discord()
export class BotButtons {
  @ButtonComponent({ id: 'set_identity' })
  async identity(interaction: ButtonInteraction) {
    await handleIdentityButton(interaction);
  }

  @ButtonComponent({ id: 'submit_report' })
  async report(interaction: ButtonInteraction) {
    await handleReportButton(interaction);
  }

  @ButtonComponent({ id: /^confirm_route\|/ })
  async confirmRoute(interaction: ButtonInteraction) {
    await handleConfirmRoute(interaction);
  }
}
