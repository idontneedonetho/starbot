import { Discord, ButtonComponent } from 'discordx';
import { type ButtonInteraction } from 'discord.js';
import { handleIdentityButton } from './identification.js';
import { handleBugButton, handleFeedbackButton, handleFeatureButton, handleConfirmRoute } from './report.js';
import { handleAssign, handleClose, handleAdditionalReportButton, handleMerge, handleSplitToThread } from './report-actions.js';

@Discord()
export class BotButtons {
  @ButtonComponent({ id: 'set_identity' })
  async identity(interaction: ButtonInteraction) {
    await handleIdentityButton(interaction);
  }

  @ButtonComponent({ id: 'report_bug' })
  async bug(interaction: ButtonInteraction) {
    await handleBugButton(interaction);
  }

  @ButtonComponent({ id: 'report_feedback' })
  async feedback(interaction: ButtonInteraction) {
    await handleFeedbackButton(interaction);
  }

  @ButtonComponent({ id: 'report_feature' })
  async feature(interaction: ButtonInteraction) {
    await handleFeatureButton(interaction);
  }

  @ButtonComponent({ id: /^cr_/ })
  async confirmRoute(interaction: ButtonInteraction) {
    await handleConfirmRoute(interaction);
  }

  @ButtonComponent({ id: /^assign_/ })
  async assign(interaction: ButtonInteraction) {
    await handleAssign(interaction);
  }

  @ButtonComponent({ id: /^close_/ })
  async close(interaction: ButtonInteraction) {
    await handleClose(interaction);
  }

  @ButtonComponent({ id: /^additional_report_/ })
  async additionalReport(interaction: ButtonInteraction) {
    await handleAdditionalReportButton(interaction);
  }

  @ButtonComponent({ id: /^merge_/ })
  async merge(interaction: ButtonInteraction) {
    await handleMerge(interaction);
  }

  @ButtonComponent({ id: /^split_/ })
  async splitToThread(interaction: ButtonInteraction) {
    await handleSplitToThread(interaction);
  }
}
