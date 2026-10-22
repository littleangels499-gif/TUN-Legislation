// amendments.js
// Amendment lifecycle. Every amendment moves through these stages, in order:
//
//   1. Pending Owner  - the resolution's owner accepts or rejects it
//                       (skipped if the owner proposed it themselves, or if
//                       "owner approval" is switched off in /config)
//   2. Under Review   - a reviewer approves or rejects it
//                       (skipped if "reviewer approval" is switched off)
//   3. Debate         - members discuss it for a set time
//   4. Voting         - the eligible voters decide
//   5. Approved       - the change is applied to the resolution's text
//
// It can also end as Rejected by Owner, Rejected (by a reviewer), Withdrawn,
// Expired (nobody decided in time), Failed (lost the vote) or Void (the text
// it pointed at changed so it can no longer be applied).
//
// All the "is this amendment sensible?" rules (duplicates, conflicts, limits)
// live in amendmentChecks.js and are re-run whenever an amendment is about to
// move forward, because the resolution's text may have changed meanwhile.
// The full amendment history stays on the resolution forever, so it's
// archived right along with it.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getConfig } = require('./config');
const { upsertResolution } = require('./resolutions');
const { isEligibleVoter, isSCMember } = require('./permissions');
const { amendmentEmbed } = require('./embeds');
const { logAudit, notify, dmUser } = require('./audit');
const checks = require('./amendmentChecks');

const AMENDMENT_TYPE_LABELS = {
  add: 'Add Text',
  remove: 'Remove Text',
  replace: 'Replace Text',
  format: 'Correct Formatting',
  reference: 'Correct References',
};

// What the two free-text modal inputs should be labeled/required as, per
// amendment type - decided once, at modal-build time, so Discord enforces
// the right fields are filled in without us needing to validate afterward.
const AMENDMENT_TYPE_MODAL_CONFIG = {
  add: { originalLabel: 'Context (optional)', originalRequired: false, newLabel: 'New Text to Add', newRequired: true },
  remove: { originalLabel: 'Exact Text to Remove', originalRequired: true, newLabel: 'Replacement Text (optional)', newRequired: false },
  replace: { originalLabel: 'Exact Original Text', originalRequired: true, newLabel: 'Replacement Text', newRequired: true },
  format: { originalLabel: 'Text Being Corrected (optional)', originalRequired: false, newLabel: 'Corrected Text', newRequired: true },
  reference: { originalLabel: 'Text Being Corrected (optional)', originalRequired: false, newLabel: 'Corrected Text', newRequired: true },
};

const STAGE_OF_STATUS = {
  'Pending Owner': 'owner',
  'Under Review': 'review',
  Debate: 'debate',
  Voting: 'vote',
};

function getAmendmentVoterRole(resolution, config) {
  return resolution.body === 'SC' ? config.securityCouncil.roles.member : config.roles.gaVoter;
}

function isAmendmentEligibleVoter(member, resolution, config) {
  return resolution.body === 'SC' ? isSCMember(member, config) : isEligibleVoter(member, config);
}

// True if this resolution has any amendment still moving through the
// pipeline. Used to hold off opening the resolution's main vote until every
// amendment has been resolved, so the "working copy" is finished first.
function hasOpenAmendments(resolution) {
  return (resolution.amendments || []).some(checks.isOpen);
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function buildAmendmentButtons(resolutionNumber, amendmentId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`amendvote_${amendmentId}_yes_${resolutionNumber}`).setLabel('Yes').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`amendvote_${amendmentId}_no_${resolutionNumber}`).setLabel('No').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`amendvote_${amendmentId}_abstain_${resolutionNumber}`).setLabel('Abstain').setEmoji('⚪').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
  );
}

function buildOwnerButtons(resolutionNumber, amendmentId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`amendown_${amendmentId}_accept_${resolutionNumber}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`amendown_${amendmentId}_reject_${resolutionNumber}`).setLabel('Reject').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );
}

function buildReviewButtons(resolutionNumber, amendmentId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`amendrev_${amendmentId}_approve_${resolutionNumber}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`amendrev_${amendmentId}_reject_${resolutionNumber}`).setLabel('Reject').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );
}

// Buttons for the card posted in the debate thread. They change as the
// amendment moves along, and disappear once nothing can be clicked any more.
function mainCardComponents(resolution, amendment) {
  if (amendment.status === 'Pending Owner') return [buildOwnerButtons(resolution.number, amendment.id)];
  if (amendment.status === 'Under Review' && amendment.reviewInThread) return [buildReviewButtons(resolution.number, amendment.id)];
  if (amendment.status === 'Voting') return [buildAmendmentButtons(resolution.number, amendment.id, false)];
  if (amendment.vote) return [buildAmendmentButtons(resolution.number, amendment.id, true)];
  return [];
}

function reviewCardComponents(resolution, amendment) {
  return amendment.status === 'Under Review' ? [buildReviewButtons(resolution.number, amendment.id)] : [];
}

// ---------------------------------------------------------------------------
// Discord helpers
// ---------------------------------------------------------------------------

async function fetchChannel(client, id) {
  return id ? client.channels.fetch(id).catch(() => null) : null;
}

async function fetchMessage(client, location) {
  if (!location || !location.channelId || !location.messageId) return null;
  const channel = await fetchChannel(client, location.channelId);
  if (!channel) return null;
  return channel.messages.fetch(location.messageId).catch(() => null);
}

function cardLocation(amendment) {
  if (amendment.card) return amendment.card;
  // Older amendments only remember where their vote card was.
  if (amendment.vote && amendment.vote.channelId && amendment.vote.messageId) {
    return { channelId: amendment.vote.channelId, messageId: amendment.vote.messageId };
  }
  return null;
}

// Edits every card this amendment has (thread card + any review-channel
// cards) so they all show its current stage and buttons.
async function refreshAmendmentMessage(client, resolution, amendment) {
  const embed = amendmentEmbed(resolution, amendment);

  const main = await fetchMessage(client, cardLocation(amendment));
  if (main) {
    await main.edit({ embeds: [embed], components: mainCardComponents(resolution, amendment) }).catch((err) => console.error('Failed to refresh amendment message:', err));
  }
  for (const location of amendment.reviewCards || []) {
    const message = await fetchMessage(client, location);
    if (message) {
      await message.edit({ embeds: [embed], components: reviewCardComponents(resolution, amendment) }).catch((err) => console.error('Failed to refresh amendment review card:', err));
    }
  }
}

// Sends a short public message in the resolution's debate thread, pinging
// the given users so they actually get notified (embeds and edits don't ping).
async function postInThread(client, resolution, amendment, content, userIds = []) {
  const config = getConfig();
  const { getDebateTargetChannelIds } = require('./voting');
  const location = cardLocation(amendment);
  const channelId = (location && location.channelId) || getDebateTargetChannelIds(resolution, config)[0];
  const channel = await fetchChannel(client, channelId);
  if (!channel) return null;
  return channel
    .send({ content, allowedMentions: { users: [...new Set(userIds)].filter(Boolean) } })
    .catch((err) => {
      console.error('Failed to post amendment update:', err);
      return null;
    });
}

// ---------------------------------------------------------------------------
// Creating an amendment
// ---------------------------------------------------------------------------

function createAmendment(resolution, { type, targetField, originalText, newText, sponsorId }) {
  const config = getConfig();
  resolution.amendments = resolution.amendments || [];

  const ownerId = resolution.submittedBy;
  const needsOwnerDecision = config.amendments.requireOwnerApproval && sponsorId !== ownerId;
  const ownerMinutes = config.amendments.ownerDecisionMinutes;
  const now = Date.now();

  const amendment = {
    id: `A${resolution.amendments.length + 1}`,
    type,
    targetField,
    originalText: originalText || null,
    newText: newText || null,
    sponsor: sponsorId,
    status: 'Pending Owner',
    flow: { owner: !!config.amendments.requireOwnerApproval, review: !!config.amendments.requireReview },
    createdAt: now,
    ownerDecision: needsOwnerDecision
      ? { decision: null, endsAt: ownerMinutes > 0 ? now + ownerMinutes * 60000 : null }
      : { decision: 'accepted', by: sponsorId, auto: true, at: now },
    review: null,
    debate: null,
    vote: null,
  };

  resolution.amendments.push(amendment);
  upsertResolution(resolution);
  return amendment;
}

// Posts the public announcement card in the debate thread. When the owner
// still has to decide, they are pinged right there with Accept / Reject buttons.
async function postAnnouncement(client, resolution, amendment) {
  const config = getConfig();
  const { getDebateTargetChannelIds } = require('./voting');
  const channel = await fetchChannel(client, getDebateTargetChannelIds(resolution, config)[0]);
  if (!channel) return;

  const awaitingOwner = amendment.ownerDecision && amendment.ownerDecision.decision === null;
  const label = AMENDMENT_TYPE_LABELS[amendment.type] || amendment.type;
  const deadline = awaitingOwner && amendment.ownerDecision.endsAt ? ` Please decide <t:${Math.floor(amendment.ownerDecision.endsAt / 1000)}:R>, or it will expire.` : '';
  const content = awaitingOwner
    ? `📝 <@${resolution.submittedBy}> — <@${amendment.sponsor}> has proposed a **${label}** amendment (**${amendment.id}**) to your resolution **${resolution.number}**. Do you accept it?${deadline}`
    : `📝 <@${amendment.sponsor}> has proposed a **${label}** amendment (**${amendment.id}**) to **${resolution.number}**.`;

  const message = await channel
    .send({
      content,
      embeds: [amendmentEmbed(resolution, amendment)],
      components: mainCardComponents(resolution, amendment),
      allowedMentions: { users: [resolution.submittedBy, amendment.sponsor] },
    })
    .catch((err) => {
      console.error('Failed to post amendment announcement:', err);
      return null;
    });
  if (message) {
    amendment.card = { channelId: channel.id, messageId: message.id };
    upsertResolution(resolution);
  }
}

// Entry point used when a member submits the amendment form.
async function submitAmendment(client, resolution, params) {
  const amendment = createAmendment(resolution, params);
  await postAnnouncement(client, resolution, amendment);

  logAudit(
    client,
    'Amendment Proposed',
    `**${resolution.number}** ${amendment.id} (${AMENDMENT_TYPE_LABELS[amendment.type]} → ${amendment.targetField}) by <@${amendment.sponsor}>`,
    resolution.body
  ).catch((err) => console.error(err));

  if (amendment.ownerDecision.decision === 'accepted') {
    await advanceAfterOwner(client, resolution, amendment);
  } else {
    dmUser(client, resolution.submittedBy, `📝 <@${amendment.sponsor}> proposed amendment **${amendment.id}** to your resolution **${resolution.number}**. Please accept or reject it in the debate thread.`);
  }
  return amendment;
}

// ---------------------------------------------------------------------------
// Moving through the stages
// ---------------------------------------------------------------------------

function endAmendment(amendment, status, extra = {}) {
  amendment.endedStage = STAGE_OF_STATUS[amendment.status] || amendment.endedStage || 'debate';
  amendment.status = status;
  amendment.endedAt = Date.now();
  if (amendment.debate) amendment.debate.closed = true;
  if (amendment.vote) amendment.vote.closed = true;
  Object.assign(amendment, extra);
}

async function advanceAfterOwner(client, resolution, amendment) {
  const config = getConfig();
  if (config.amendments.requireReview) return startReview(client, resolution, amendment);
  return startDebate(client, resolution, amendment);
}

async function startReview(client, resolution, amendment) {
  const config = getConfig();
  const { getReviewChannelIds, getReviewerMentions } = require('./voting');
  const minutes = config.amendments.reviewDecisionMinutes;
  const now = Date.now();

  amendment.status = 'Under Review';
  amendment.review = { startedAt: now, endsAt: minutes > 0 ? now + minutes * 60000 : null, decision: null };
  amendment.reviewCards = [];

  const channelIds = getReviewChannelIds(resolution, config);
  // No review channel set up -> reviewers act on the card in the debate thread.
  amendment.reviewInThread = channelIds.length === 0;
  const mention = getReviewerMentions(resolution, config);

  for (const channelId of channelIds) {
    const channel = await fetchChannel(client, channelId);
    if (!channel) continue;
    const message = await channel
      .send({
        content: `${mention}📝 Amendment **${amendment.id}** to **${resolution.number}** is ready for review${
          amendment.review.endsAt ? ` (decide <t:${Math.floor(amendment.review.endsAt / 1000)}:R>)` : ''
        }.`,
        embeds: [amendmentEmbed(resolution, amendment)],
        components: reviewCardComponents(resolution, amendment),
      })
      .catch((err) => {
        console.error('Failed to post amendment to review channel:', err);
        return null;
      });
    if (message) amendment.reviewCards.push({ channelId: channel.id, messageId: message.id });
  }

  upsertResolution(resolution);
  await refreshAmendmentMessage(client, resolution, amendment);

  const ownerAccepted = amendment.ownerDecision && !amendment.ownerDecision.auto;
  await postInThread(
    client,
    resolution,
    amendment,
    `${ownerAccepted ? `✅ <@${resolution.submittedBy}> accepted amendment **${amendment.id}**. ` : ''}It is now with the reviewers${
      amendment.reviewInThread && mention ? ` (${mention.trim()})` : ''
    } before debate opens.`,
    [resolution.submittedBy, amendment.sponsor]
  );
}

async function startDebate(client, resolution, amendment) {
  const config = getConfig();
  const now = Date.now();
  amendment.status = 'Debate';
  amendment.debate = { startedAt: now, endsAt: now + config.amendments.debateDurationMinutes * 60000, closed: false };
  upsertResolution(resolution);
  await refreshAmendmentMessage(client, resolution, amendment);

  await postInThread(
    client,
    resolution,
    amendment,
    `💬 Amendment **${amendment.id}** to **${resolution.number}** is now open for debate until <t:${Math.floor(amendment.debate.endsAt / 1000)}:f>. Voting will open automatically afterwards. <@${resolution.submittedBy}>`,
    [resolution.submittedBy]
  );
}

// The owner's say. decision: 'accept' | 'reject'.
// Accepting is only possible at the first stage; rejecting is possible any
// time before the vote opens (so an owner can change their mind after
// accepting). Admins can decide on the owner's behalf if the owner is away.
async function ownerDecide(client, resolution, amendment, actor, decision, reason = null) {
  const onBehalf = actor.id !== resolution.submittedBy;

  if (decision === 'accept') {
    if (amendment.status !== 'Pending Owner') {
      return { ok: false, error: `This amendment is not waiting for the owner's decision (status: ${amendment.status}).` };
    }
    const problem = checks.validateStillApplicable(resolution, amendment) || checks.validateAgainstOthers(resolution, amendment);
    if (problem) return { ok: false, error: `It can no longer be accepted: ${problem}` };

    amendment.ownerDecision = { decision: 'accepted', by: actor.id, onBehalf, reason, at: Date.now() };
    upsertResolution(resolution);
    logAudit(client, 'Amendment Accepted by Owner', `**${resolution.number}** ${amendment.id} — accepted by <@${actor.id}>${onBehalf ? ' (on the owner\'s behalf)' : ''}.`, resolution.body).catch((err) => console.error(err));
    dmUser(client, amendment.sponsor, `✅ **${resolution.number}**: your amendment **${amendment.id}** was accepted by the resolution owner and moves on to the next stage.`);
    await advanceAfterOwner(client, resolution, amendment);
    return { ok: true };
  }

  // reject
  if (!['Pending Owner', 'Under Review', 'Debate'].includes(amendment.status)) {
    return { ok: false, error: `The owner can only reject an amendment before its vote opens (status: ${amendment.status}).` };
  }
  amendment.ownerDecision = { decision: 'rejected', by: actor.id, onBehalf, reason, at: Date.now() };
  endAmendment(amendment, 'Rejected by Owner', { rejectionReason: reason });
  upsertResolution(resolution);
  await refreshAmendmentMessage(client, resolution, amendment);

  logAudit(client, 'Amendment Rejected by Owner', `**${resolution.number}** ${amendment.id} — rejected by <@${actor.id}>${reason ? `\nReason: ${reason}` : ''}`, resolution.body).catch((err) => console.error(err));
  await postInThread(
    client,
    resolution,
    amendment,
    `❌ Amendment **${amendment.id}** to **${resolution.number}** was rejected by <@${actor.id}>${onBehalf ? ' (acting for the resolution owner)' : ' (the resolution owner)'}.${reason ? ` Reason: ${reason}` : ''} <@${amendment.sponsor}>`,
    [amendment.sponsor, actor.id]
  );
  dmUser(client, amendment.sponsor, `❌ **${resolution.number}**: your amendment **${amendment.id}** was rejected by the resolution owner.${reason ? ` Reason: ${reason}` : ''}`);
  return { ok: true };
}

// A reviewer's say. decision: 'approve' | 'reject'.
async function reviewDecide(client, resolution, amendment, actor, decision, reason = null) {
  if (amendment.status !== 'Under Review') {
    return { ok: false, error: `This amendment is not waiting for review (status: ${amendment.status}).` };
  }

  if (decision === 'approve') {
    const problem = checks.validateStillApplicable(resolution, amendment) || checks.validateAgainstOthers(resolution, amendment);
    if (problem) return { ok: false, error: `It cannot be approved: ${problem}` };

    amendment.review = { ...amendment.review, decision: 'approved', by: actor.id, reason, at: Date.now() };
    upsertResolution(resolution);
    logAudit(client, 'Amendment Approved by Reviewer', `**${resolution.number}** ${amendment.id} — approved by <@${actor.id}>.`, resolution.body).catch((err) => console.error(err));
    dmUser(client, amendment.sponsor, `✅ **${resolution.number}**: your amendment **${amendment.id}** passed review and is going to debate.`);
    await startDebate(client, resolution, amendment);
    return { ok: true };
  }

  amendment.review = { ...amendment.review, decision: 'rejected', by: actor.id, reason, at: Date.now() };
  endAmendment(amendment, 'Rejected', { rejectionReason: reason });
  upsertResolution(resolution);
  await refreshAmendmentMessage(client, resolution, amendment);

  logAudit(client, 'Amendment Rejected by Reviewer', `**${resolution.number}** ${amendment.id} — rejected by <@${actor.id}>${reason ? `\nReason: ${reason}` : ''}`, resolution.body).catch((err) => console.error(err));
  await postInThread(
    client,
    resolution,
    amendment,
    `❌ Amendment **${amendment.id}** to **${resolution.number}** did not pass review.${reason ? ` Reason: ${reason}` : ''} <@${resolution.submittedBy}> <@${amendment.sponsor}>`,
    [resolution.submittedBy, amendment.sponsor]
  );
  dmUser(client, amendment.sponsor, `❌ **${resolution.number}**: your amendment **${amendment.id}** was rejected in review.${reason ? ` Reason: ${reason}` : ''}`);
  return { ok: true };
}

async function withdrawAmendment(client, resolution, amendment, actor) {
  if (!checks.isOpen(amendment)) {
    return { ok: false, error: `This amendment can no longer be withdrawn (status: ${amendment.status}).` };
  }
  endAmendment(amendment, 'Withdrawn', { withdrawnBy: actor.id });
  upsertResolution(resolution);
  await refreshAmendmentMessage(client, resolution, amendment);
  logAudit(client, 'Amendment Withdrawn', `**${resolution.number}** ${amendment.id} — withdrawn by <@${actor.id}>.`, resolution.body).catch((err) => console.error(err));
  await postInThread(client, resolution, amendment, `↩️ Amendment **${amendment.id}** to **${resolution.number}** was withdrawn. <@${resolution.submittedBy}>`, [resolution.submittedBy]);
  return { ok: true };
}

// Called by the scheduler when nobody decided in time.
async function expireAmendment(client, resolution, amendment) {
  const stage = amendment.status === 'Pending Owner' ? "the resolution owner didn't respond" : 'no reviewer responded';
  endAmendment(amendment, 'Expired', { appliedNote: `Expired: ${stage} in time.` });
  upsertResolution(resolution);
  await refreshAmendmentMessage(client, resolution, amendment);
  logAudit(client, 'Amendment Expired', `**${resolution.number}** ${amendment.id} — ${stage} in time.`, resolution.body).catch((err) => console.error(err));
  await postInThread(client, resolution, amendment, `⌛ Amendment **${amendment.id}** to **${resolution.number}** expired because ${stage} in time. <@${amendment.sponsor}>`, [amendment.sponsor]);
  dmUser(client, amendment.sponsor, `⌛ **${resolution.number}**: your amendment **${amendment.id}** expired because ${stage} in time.`);
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

async function openAmendmentVote(client, resolution, amendment) {
  const config = getConfig();
  const { getEligibleCount, getDebateTargetChannelIds } = require('./voting');

  // The text may have changed since this was proposed - make sure it still fits.
  const problem = checks.validateStillApplicable(resolution, amendment);
  if (problem) {
    endAmendment(amendment, 'Void', { appliedNote: `Could not go to a vote: ${problem}` });
    upsertResolution(resolution);
    await refreshAmendmentMessage(client, resolution, amendment);
    await postInThread(client, resolution, amendment, `⚠️ Amendment **${amendment.id}** to **${resolution.number}** is void: ${problem} <@${amendment.sponsor}>`, [amendment.sponsor]);
    return amendment;
  }

  const roleId = getAmendmentVoterRole(resolution, config);
  const eligibleCount = await getEligibleCount(client, roleId);

  amendment.status = 'Voting';
  amendment.vote = {
    ballots: {},
    eligibleCount,
    quorumPercent: config.amendments.quorumPercent,
    thresholdPercent: config.amendments.majorityPercent,
    startedAt: Date.now(),
    endsAt: Date.now() + config.amendments.votingDurationMinutes * 60000,
    closed: false,
    result: null,
    messageId: null,
    channelId: null,
  };

  // Reuse the card already in the thread; post a fresh one only if it is gone.
  let location = cardLocation(amendment);
  let message = await fetchMessage(client, location);
  if (!message) {
    const channel = await fetchChannel(client, getDebateTargetChannelIds(resolution, config)[0]);
    if (channel) {
      message = await channel.send({ embeds: [amendmentEmbed(resolution, amendment)], components: mainCardComponents(resolution, amendment) }).catch(() => null);
      if (message) amendment.card = { channelId: channel.id, messageId: message.id };
    }
  }
  location = cardLocation(amendment);
  if (location) {
    amendment.vote.messageId = location.messageId;
    amendment.vote.channelId = location.channelId;
  }

  upsertResolution(resolution);
  await refreshAmendmentMessage(client, resolution, amendment);
  await postInThread(
    client,
    resolution,
    amendment,
    `🗳️ Voting is now open on amendment **${amendment.id}** to **${resolution.number}**. It closes <t:${Math.floor(amendment.vote.endsAt / 1000)}:R>. <@${resolution.submittedBy}>`,
    [resolution.submittedBy]
  );
  await logAudit(client, 'Amendment Voting Opened', `**${resolution.number}** ${amendment.id} (${AMENDMENT_TYPE_LABELS[amendment.type]}) — voting has opened.`, resolution.body);
  return amendment;
}

// Applies an Approved amendment to the resolution's working text, using the
// exact same logic the checks used. Returns { ok, error? }.
function applyAmendment(resolution, amendment) {
  const field = amendment.targetField;
  if (!resolution.fields || !(field in resolution.fields)) return { ok: false, error: 'the field no longer exists' };
  const result = checks.computeResult(resolution.fields[field] || '', amendment);
  if (!result.ok) return result;
  if (result.text.length > checks.MAX_FIELD_LENGTH) return { ok: false, error: 'the result would be too long for the field' };
  resolution.fields[field] = result.text;
  return { ok: true };
}

async function closeAmendmentVote(client, resolution, amendment) {
  const ballots = Object.values(amendment.vote.ballots || {});
  const votesCast = ballots.length;
  const participation = amendment.vote.eligibleCount > 0 ? (votesCast / amendment.vote.eligibleCount) * 100 : 0;
  const weightedYes = ballots.filter((v) => v.choice === 'yes').reduce((s, v) => s + v.weight, 0);
  const weightedNo = ballots.filter((v) => v.choice === 'no').reduce((s, v) => s + v.weight, 0);
  const decisive = weightedYes + weightedNo;
  const yesShare = decisive > 0 ? (weightedYes / decisive) * 100 : 0;

  let result;
  if (participation < amendment.vote.quorumPercent) result = 'Failed';
  else if (yesShare >= amendment.vote.thresholdPercent) result = 'Approved';
  else result = 'Failed';

  let note = null;
  if (result === 'Approved') {
    const applied = applyAmendment(resolution, amendment);
    if (!applied.ok) {
      // It won the vote but the text it pointed at has since changed, so it
      // cannot be applied. Say so plainly rather than silently doing nothing.
      result = 'Void';
      note = `Won the vote but could not be applied: ${applied.error}.`;
    }
  }

  amendment.vote.tally = { votesCast, participation, weightedYes, weightedNo };
  endAmendment(amendment, result, note ? { appliedNote: note } : {});
  amendment.endedStage = 'vote';

  upsertResolution(resolution);
  await refreshAmendmentMessage(client, resolution, amendment);

  await logAudit(client, 'Amendment Vote Closed', `**${resolution.number}** ${amendment.id} — Result: ${result}`, resolution.body);
  await notify(client, `📝 Amendment ${amendment.id} on **${resolution.number}** has closed. Result: **${result}**.`, resolution.body);

  await postInThread(
    client,
    resolution,
    amendment,
    `📝 Voting on amendment **${amendment.id}** to **${resolution.number}** has closed. Result: **${result}**.${
      result === 'Approved' ? ' The resolution text has been updated.' : note ? ` ${note}` : ''
    } <@${resolution.submittedBy}>`,
    [resolution.submittedBy, amendment.sponsor]
  );

  dmUser(client, amendment.sponsor, `📝 Your amendment ${amendment.id} to **${resolution.number}** has closed. Result: **${result}**.`);
  if (resolution.submittedBy !== amendment.sponsor) {
    dmUser(client, resolution.submittedBy, `📝 An amendment (${amendment.id}) to your resolution **${resolution.number}** has closed. Result: **${result}**.`);
  }

  return amendment;
}

module.exports = {
  AMENDMENT_TYPE_LABELS,
  AMENDMENT_TYPE_MODAL_CONFIG,
  getAmendmentVoterRole,
  isAmendmentEligibleVoter,
  hasOpenAmendments,
  buildAmendmentButtons,
  buildOwnerButtons,
  buildReviewButtons,
  createAmendment,
  submitAmendment,
  ownerDecide,
  reviewDecide,
  withdrawAmendment,
  expireAmendment,
  openAmendmentVote,
  closeAmendmentVote,
  refreshAmendmentMessage,
};
