'use strict';

/**
 * Evaluate a single Mojang rule's conditions against a context.
 * ctx: { osName, osArch, osVersion, features }
 */
function ruleMatches(rule, ctx) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== ctx.osName) return false;
    if (rule.os.arch && rule.os.arch !== ctx.osArch) return false;
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(String(ctx.osVersion || ''))) return false;
      } catch {
        return false;
      }
    }
  }
  if (rule.features) {
    const features = ctx.features || {};
    for (const [key, expected] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== Boolean(expected)) return false;
    }
  }
  return true;
}

/**
 * Mojang semantics: no rules => allowed. Otherwise start disallowed and
 * the last matching rule decides.
 */
function isAllowed(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, ctx)) allowed = rule.action === 'allow';
  }
  return allowed;
}

module.exports = { isAllowed, ruleMatches };
