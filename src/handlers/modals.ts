import { Discord, ModalComponent } from 'discordx';
import { type ModalSubmitInteraction } from 'discord.js';
import { handleIdentitySubmit } from './identification.js';
import { handleBugSubmit, handleFeedbackSubmit } from './report.js';

@Discord()
export class BotModals {
  @ModalComponent({ id: 'identity_modal' })
  async identity(interaction: ModalSubmitInteraction) {
    await handleIdentitySubmit(interaction);
  }

  @ModalComponent({ id: 'bug_modal' })
  async bug(interaction: ModalSubmitInteraction) {
    await handleBugSubmit(interaction);
  }

  @ModalComponent({ id: 'feedback_modal' })
  async feedback(interaction: ModalSubmitInteraction) {
    await handleFeedbackSubmit(interaction, 'feedback');
  }

  @ModalComponent({ id: 'feature_modal' })
  async feature(interaction: ModalSubmitInteraction) {
    await handleFeedbackSubmit(interaction, 'feature');
  }
}
