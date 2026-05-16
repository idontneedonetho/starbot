import { Discord, SelectMenuComponent } from 'discordx';
import { type StringSelectMenuInteraction } from 'discord.js';
import { handleReportTypeSelect } from './report.js';

@Discord()
export class BotSelectMenus {
  @SelectMenuComponent({ id: 'report_type_select' })
  async reportType(interaction: StringSelectMenuInteraction) {
    await handleReportTypeSelect(interaction);
  }
}
