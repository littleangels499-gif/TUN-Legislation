// amendmentChecks.js
// Every "is this amendment sensible?" rule lives here, so the same checks run
// when an amendment is proposed AND again right before it is applied (the
// resolution's text can change in between, e.g. when an earlier amendment is
// approved).
//
// An amendment is "open" while it is anywhere between being proposed and
// having its vote closed. Open amendments on the same field are compared
// against each other so two of them can never fight over the same text.

const OPEN_STATUSES = ['Pending Owner', 'Under Review', 'Debate', 'Voting'];

// Resolution fields are edited through a Discord pop-up form, which allows at
// most 4000 characters per field - an amendment must never push a field past
// that, or the resolution could no longer be edited.
const MAX_FIELD_LENGTH = 4000;

const TYPE_REQUIREMENTS = {
  add: { original: false, new: true },
  remove: { original: true, new: false },
  replace: { original: true, new: true },
  format: { original: false, new: true },
  reference: { original: false, new: true },
};

function isOpen(amendment) {
  return OPEN_STATUSES.includes(amendment.status);
}

// Case/whitespace-insensitive form, used only to spot duplicates.
function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

// Works out what a field would look like after an amendment is applied.
// Returns { ok: true, text } or { ok: false, error }. This is the single
// source of truth for "what would this amendment do" - applyAmendment uses
// it too, so what was checked is exactly what gets applied.
function computeResult(currentText, amendment) {
  const current = currentText || '';
  const original = amendment.originalText || '';
  const replacement = amendment.newText || '';

  if (amendment.type === 'add') {
    return { ok: true, text: `${current}\n${replacement}`.trim() };
  }

  // format / reference with no original text to point at behave like an append.
  if (!original && (amendment.type === 'format' || amendment.type === 'reference')) {
    return { ok: true, text: `${current}\n${replacement}`.trim() };
  }

  const occurrences = countOccurrences(current, original);
  if (occurrences === 0) {
    return { ok: false, error: 'the text this amendment points at is no longer in the field (it may have been changed by another amendment)' };
  }
  if (occurrences > 1) {
    return { ok: false, error: `the text this amendment points at now appears ${occurrences} times, so it is unclear which one to change` };
  }

  const at = current.indexOf(original);
  const before = current.slice(0, at);
  const after = current.slice(at + original.length);
  return { ok: true, text: `${before}${amendment.type === 'remove' ? '' : replacement}${after}`.trim() };
}

// Checks one amendment on its own against the resolution's CURRENT text.
// Returns an error string, or null if it is fine.
function validateContent(resolution, amendment) {
  const { targetField, type } = amendment;
  const original = (amendment.originalText || '').trim();
  const replacement = (amendment.newText || '').trim();

  if (!resolution.fields || !(targetField in resolution.fields)) {
    return `The field **${targetField}** does not exist on this resolution.`;
  }
  const requirements = TYPE_REQUIREMENTS[type];
  if (!requirements) return 'Unknown amendment type.';
  if (requirements.original && !original) return 'This type of amendment needs the exact original text.';
  if (requirements.new && !replacement) return 'This type of amendment needs the new text.';

  if (original && replacement && normalize(original) === normalize(replacement)) {
    return 'The original and new text are the same, so this amendment would change nothing.';
  }

  const current = resolution.fields[targetField] || '';

  if (original) {
    const occurrences = countOccurrences(current, original);
    if (occurrences === 0) {
      return `The original text was not found exactly as written in **${targetField}**. Copy it straight from the resolution, including punctuation.`;
    }
    if (occurrences > 1) {
      return `The original text appears **${occurrences} times** in **${targetField}**, so it is unclear which one you mean. Include a little more surrounding text so it matches exactly one place.`;
    }
  }

  if (type === 'add' && normalize(current).includes(normalize(replacement))) {
    return `That text is already part of **${targetField}**.`;
  }

  const result = computeResult(current, { ...amendment, originalText: original, newText: replacement });
  if (!result.ok) return `This amendment cannot be applied: ${result.error}.`;
  if (result.text.length > MAX_FIELD_LENGTH) {
    return `Applying this would make **${targetField}** longer than ${MAX_FIELD_LENGTH} characters, which is the most a field can hold.`;
  }
  return null;
}

// Compares an amendment against the other OPEN amendments on the same field.
// Returns an error string, or null if there is no problem.
function validateAgainstOthers(resolution, amendment) {
  const others = (resolution.amendments || []).filter(
    (other) => other.id !== amendment.id && isOpen(other) && other.targetField === amendment.targetField
  );
  const current = (resolution.fields && resolution.fields[amendment.targetField]) || '';
  const original = (amendment.originalText || '').trim();

  for (const other of others) {
    // Duplicate: asks for exactly the same change.
    if (normalize(other.originalText) === normalize(original) && normalize(other.newText) === normalize(amendment.newText)) {
      return `This duplicates amendment **${other.id}** (by <@${other.sponsor}>), which is still open.`;
    }

    // Conflict: both want to change the same stretch of text.
    if (original && other.originalText) {
      const mine = current.indexOf(original);
      const theirs = current.indexOf(other.originalText);
      if (mine !== -1 && theirs !== -1) {
        const overlaps = mine < theirs + other.originalText.length && theirs < mine + original.length;
        if (overlaps) {
          return `This conflicts with amendment **${other.id}** (by <@${other.sponsor}>), which is still open and changes the same part of **${amendment.targetField}**. Wait until it is decided, or ask its sponsor to withdraw it.`;
        }
      }
    }
  }
  return null;
}

// Stops one member from flooding a resolution with amendments.
function validateMemberLimit(resolution, sponsorId, limit) {
  if (!limit || limit <= 0) return null;
  const open = (resolution.amendments || []).filter((a) => a.sponsor === sponsorId && isOpen(a)).length;
  if (open >= limit) {
    return `You already have ${open} open amendment(s) on this resolution - the most allowed at once is ${limit}. Wait for one to be decided, or withdraw one.`;
  }
  return null;
}

// Amendments only make sense while the resolution's own debate is still
// running - once that window has ended the main vote is about to open, and a
// fresh amendment would just hold it up.
function validateWindow(resolution) {
  if (resolution.status !== 'Debate') return `Amendments can only be proposed while a resolution is in Debate (status: ${resolution.status}).`;
  if (resolution.debate && resolution.debate.endsAt && Date.now() >= resolution.debate.endsAt) {
    return 'The debate period for this resolution has ended, so new amendments can no longer be proposed.';
  }
  return null;
}

// Full check for a brand-new proposal. Returns an error string, or null.
function validateProposal(resolution, proposal, config) {
  return (
    validateWindow(resolution) ||
    validateMemberLimit(resolution, proposal.sponsorId, config.amendments.maxOpenPerMember) ||
    validateContent(resolution, proposal) ||
    validateAgainstOthers(resolution, { ...proposal, id: null, sponsor: proposal.sponsorId })
  );
}

// Re-check used later in the amendment's life (owner accepts, reviewer
// approves, vote opens): the text may have moved on since it was proposed.
function validateStillApplicable(resolution, amendment) {
  return validateContent(resolution, amendment);
}

module.exports = {
  OPEN_STATUSES,
  MAX_FIELD_LENGTH,
  isOpen,
  normalize,
  computeResult,
  validateContent,
  validateAgainstOthers,
  validateMemberLimit,
  validateWindow,
  validateProposal,
  validateStillApplicable,
};
