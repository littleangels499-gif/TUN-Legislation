// /veto command
// The Veto button on the Security Council voting card is the primary way
// to cast a veto, but this command gives Permanent Members a way to cast
// one with a written reason attached, and gives admins control over
// starting/closing override votes.

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('../lib/config');
const { isAdmin, isSCPermanentMember } = require('../lib/permissions');
const { findResolution } = require('../lib/resolutions');
const { resolutionEmbed } = require('../lib/embeds');
const { castVeto, removeVeto, openOverrideVote, closeOverrideVote } = require('../lib/voting');

module.exports = {
  category: 'Security Council',
  data: new SlashCommandBuilder()
    .setName('veto')
    .setDescription('Veto controls')
    .addSubcommand((sub) =>
      sub
        .setName('cast')
        .setDescription('Cast a veto on a resolution currently being voted on by the Security Council')
        .addStringOption((o) => o.setName('number').setDescription('Resolution number').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason for the veto (optional)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('retract')
        .setDescription('Retract a veto you previously cast on a resolution')
        .addStringOption((o) => o.setName('number').setDescription('Resolution number').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Check whether a resolution has been vetoed')
        .addStringOption((o) => o.setName('number').setDescription('Resolution number').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('override-start')
        .setDescription('Start a veto override vote (admin only)')
        .addStringOption((o) => o.setName('number').setDescription('Resolution number').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('override-close')
        .setDescription('Manually close a veto override vote (admin only)')
        .addStringOption((o) => o.setName('number').setDescription('Resolution number').setRequired(true).setAutocomplete(true))
    ),

  async execute(interaction) {
    const config = getConfig();
    const sub = interaction.options.getSubcommand();
    const number = interaction.options.getString('number');
    const resolution = findResolution(number);

    if (!resolution) {
      return interaction.reply({ content: `❌ No resolution found with number **${number}**.`, ephemeral: true });
    }

    if (sub === 'cast') {
      if (!isSCPermanentMember(interaction.member, config)) {
        return interaction.reply({ content: '❌ Only Permanent Security Council Members may cast a veto.', ephemeral: true });
      }
      const track = resolution.tracks && resolution.tracks.SC;
      if (!track || track.closed) {
        return interaction.reply({ content: '❌ There is no open Security Council vote on this resolution.', ephemeral: true });
      }
      const reason = interaction.options.getString('reason');

      await interaction.deferReply({ ephemeral: true });
      const result = await castVeto(interaction.client, resolution, interaction.member, reason);

      const messages = {
        already_vetoed: `🚫 **${resolution.number}** has already been vetoed (${result.count}/${result.required} Permanent Members).`,
        duplicate: `You have already cast a veto on **${resolution.number}** (${result.count}/${result.required} Permanent Members so far).`,
        recorded: `🚫 Your veto on **${resolution.number}** has been recorded (${result.count}/${result.required} Permanent Members needed). It will not take effect until enough other Permanent Members also veto it.`,
        vetoed: `🚫 **${resolution.number}** has been vetoed — ${result.count}/${result.required} Permanent Members have now vetoed it.`,
        closed: '❌ There is no open Security Council vote on this resolution.',
      };
      return interaction.editReply({ content: messages[result.status] || '🚫 Your veto has been cast.' });
    }

    if (sub === 'retract') {
      if (!isSCPermanentMember(interaction.member, config)) {
        return interaction.reply({ content: '❌ Only Permanent Security Council Members may retract a veto.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const result = await removeVeto(interaction.client, resolution, interaction.member);

      const messages = {
        removed: `✅ Your veto on **${resolution.number}** has been retracted (${result.count}/${result.required} Permanent Members now).`,
        not_found: `You have not cast a veto on **${resolution.number}**.`,
        closed: '❌ This vote has already closed — the veto can no longer be retracted.',
      };
      return interaction.editReply({ content: messages[result.status] || '✅ Your veto has been retracted.' });
    }

    if (sub === 'status') {
      const scTrack = resolution.tracks && resolution.tracks.SC;
      const vetoes = scTrack ? scTrack.vetoes || (scTrack.vetoedBy ? [scTrack.vetoedBy] : []) : [];
      if (vetoes.length === 0) {
        return interaction.reply({ content: `**${resolution.number}** has not had any vetoes cast on it.`, ephemeral: true });
      }
      return interaction.reply({ embeds: [resolutionEmbed(resolution)], ephemeral: true });
    }

    if (sub === 'override-start') {
      if (!isAdmin(interaction.member, config)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      }
      try {
        await interaction.deferReply({ ephemeral: true });
        await openOverrideVote(interaction.client, resolution);
        return interaction.editReply({ content: `✅ Veto override vote started for **${resolution.number}**.` });
      } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
      }
    }

    if (sub === 'override-close') {
      if (!isAdmin(interaction.member, config)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      }
      if (resolution.status !== 'Veto Override Vote') {
        return interaction.reply({ content: `❌ This resolution does not have an active override vote (status: ${resolution.status}).`, ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const updated = await closeOverrideVote(interaction.client, resolution);
      return interaction.editReply({ content: `✅ Override vote closed for **${updated.number}**. Result: **${updated.status}**.` });
    }
  },
};
