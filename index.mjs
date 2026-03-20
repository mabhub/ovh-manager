#!/bin/sh
//bin/false || export NVM_DIR="$HOME/.nvm"
//bin/false || [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
//bin/false || nvm use 18 --silent
//bin/false || exec /usr/bin/env node --no-warnings --max-http-header-size 15000 "$0" "$@"

import { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

import dotenv from 'dotenv';
import OVH from 'ovh';
import Table from 'cli-table3';
import chalk from 'chalk';
import { Command } from 'commander';

/**
 * Validate and sanitize a CLI argument (local part, email or id).
 * Throws an Error if invalid.
 * @param {string} value - The CLI argument to validate.
 * @param {'localOrEmail'|'email'|'id'} type - The expected type of the argument.
 * @returns {string} - The sanitized value.
 * @throws {Error} - If the value is invalid.
 * @author Copilot
 */
const validateCliArg = (value, type) => {
  if (typeof value !== 'string') {
    throw new Error('Invalid argument: value must be a string.');
  }
  const trimmed = value.trim();
  if (type === 'id') {
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('Invalid id: must be a positive integer.');
    }
    return trimmed;
  }
  if (type === 'email') {
    // Simple RFC5322-like email validation
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      throw new Error('Invalid email address.');
    }
    return trimmed;
  }
  if (type === 'localOrEmail') {
    // Accept local part (no @) or full email
    if (/^[^@\s]+$/.test(trimmed)) {
      return trimmed;
    }
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      return trimmed;
    }
    throw new Error('Invalid local part or email address.');
  }
  throw new Error('Unknown validation type.');
}

/**
 * Mask sensitive values (API keys, secrets, tokens) in any object or string for logging.
 * @param {any} input - The value to sanitize for logs.
 * @returns {any} - The sanitized value.
 * @author Copilot
 */
const maskSecretsInLog = (input) => {
  const secrets = [
    process.env.APP_KEY,
    process.env.APP_SECRET,
    process.env.CONSUMER_KEY,
    process.env.DEFAULT_TO,
  ].filter(Boolean);
  let str = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  for (const secret of secrets) {
    if (secret && typeof secret === 'string' && secret.length > 4) {
      // Only mask if the secret is not trivial
      const safe = '[REDACTED]';
      str = str.split(secret).join(safe);
    }
  }
  return str;
}

/**
 * Truncate text to fit terminal width, respecting column count.
 * @param {string} text - Text to truncate
 * @param {number} maxWidth - Maximum width for this cell
 * @returns {string} - Truncated text with ellipsis if needed
 */
const truncateCell = (text, maxWidth) => {
  if (!text) return 'N/A';
  const str = String(text);
  if (str.length <= maxWidth) return str;
  return str.substring(0, Math.max(1, maxWidth - 3)) + '...';
};

/**
 * Escape a value for safe CSV output (RFC 4180).
 * @param {any} val - Value to escape
 * @returns {string} - Escaped string
 */
const csvEscape = (val) => String(val ?? 'N/A').replace(/"/g, '""');

/**
 * Format data for output in different formats (table, json, csv).
 * @param {Array} data - Array of objects to format
 * @param {string} format - Output format: 'table' (default), 'json', or 'csv'
 * @param {Array} columns - Column names for table/csv (auto-detect if not provided)
 * @returns {string} - Formatted output
 */
const formatOutput = (data, format = 'table', columns = null) => {
  if (!data || data.length === 0) {
    return format === 'json' ? '[]' : '';
  }

  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  // Auto-detect columns from first object if not provided
  const cols = columns || Object.keys(data[0]);

  if (format === 'csv') {
    const rows = data.map(item =>
      cols.map(col => `"${csvEscape(item[col])}"`)
    );
    return [cols.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  // Default: table format with smart truncation
  const terminalWidth = process.stdout.columns || 120;

  // Calculate if truncation is needed
  let needsTruncation = false;
  let estimatedWidth = 0;
  const estimatedColWidths = {};

  for (const col of cols) {
    let maxLen = col.length;
    for (const item of data) {
      const val = String(item[col] || 'N/A');
      maxLen = Math.max(maxLen, val.length);
    }
    estimatedColWidths[col] = maxLen;
    estimatedWidth += maxLen;
  }
  estimatedWidth += cols.length + 1 + (cols.length * 2); // Borders + padding

  if (estimatedWidth > terminalWidth) {
    needsTruncation = true;
  }

  // Prepare rows: truncate if necessary
  const processedData = data.map(item => {
    const row = {};
    for (const col of cols) {
      const val = item[col];
      if (needsTruncation && estimatedColWidths[col] > 30) {
        // Only truncate large columns
        row[col] = truncateCell(val, Math.min(estimatedColWidths[col], 45));
      } else {
        row[col] = val || 'N/A';
      }
    }
    return row;
  });

  const output = new Table({
    head: cols.map(col => chalk.cyan(col)),
  });

  output.push(...processedData.map(item =>
    cols.map(col => item[col] || 'N/A')
  ));

  return output.toString();
};

/**
 * Format redirections with special styling (colors, alignment).
 * @param {Array} redirections - Array of redirection objects
 * @param {string} format - Output format: 'table' (default), 'json', or 'csv'
 * @returns {string} - Formatted output
 */
const formatRedirections = (redirections, format = 'table') => {
  if (format === 'json') {
    return JSON.stringify(redirections, null, 2);
  }
  if (format === 'csv') {
    const headers = ['id', 'from', 'to'];
    const rows = redirections.map(({ id, from, to }) => [
      `"${csvEscape(id)}"`,
      `"${csvEscape(from)}"`,
      `"${csvEscape(to)}"`,
    ]);
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }
  // Default: table format with styling and smart truncation
  const cols = ['id', 'from', 'to'];
  const terminalWidth = process.stdout.columns || 120;

  // Check if truncation is needed
  let needsTruncation = false;
  const estimatedColWidths = {};

  for (const col of cols) {
    let maxLen = col.length;
    for (const redir of redirections) {
      const val = String(redir[col] || 'N/A');
      maxLen = Math.max(maxLen, val.length);
    }
    estimatedColWidths[col] = maxLen;
  }
  let estimatedWidth = Object.values(estimatedColWidths).reduce((a, b) => a + b, 0);
  estimatedWidth += cols.length + 1 + (cols.length * 2);

  if (estimatedWidth > terminalWidth) {
    needsTruncation = true;
  }

  const output = new Table({
    head: cols.map(col => chalk.cyan(col)),
  });

  output.push(...redirections.map(({ id, from, to }) => [
    { content: chalk.gray(needsTruncation && estimatedColWidths.id > 15 ? truncateCell(id, 12) : id), hAlign: 'left' },
    { content: prettyMail(needsTruncation ? truncateCell(from, 30) : from), hAlign: 'right' },
    { content: prettyMail(needsTruncation ? truncateCell(to, 30) : to), hAlign: 'right' },
  ]));

  return output.toString();
};

/**
 * Sort redirections by column and direction.
 * @param {Array} redirections - Array of redirection objects
 * @param {string} sortBy - Column to sort by: 'from', 'to', or 'id' (default: 'from')
 * @param {string} order - Sort order: 'asc' (default) or 'desc'
 * @returns {Array} - Sorted redirections
 */
const sortRedirections = (redirections, sortBy = 'from', order = 'asc') => {
  const validColumns = ['from', 'to', 'id'];
  const col = validColumns.includes(sortBy) ? sortBy : 'from';
  const sorted = [...redirections].sort((a, b) => {
    const aVal = String(a[col]);
    const bVal = String(b[col]);
    return aVal.localeCompare(bVal);
  });
  return order === 'desc' ? sorted.reverse() : sorted;
};

/**
 * Filter redirections by search string across all fields (id, from, to).
 * @param {Array} redirections - Array of redirection objects
 * @param {string} searchStr - String to search for (case-insensitive)
 * @returns {Array} - Filtered redirections
 */
const filterRedirections = (redirections, searchStr) => {
  if (!searchStr) return redirections;
  const query = searchStr.toLowerCase();
  return redirections.filter(({ id, from, to }) =>
    id.toLowerCase().includes(query) ||
    from.toLowerCase().includes(query) ||
    to.toLowerCase().includes(query)
  );
};

const basePath = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: `${basePath}/.env.local` });

const ovhRequest = (...args) => new Promise((res, err) => {
  ovh.request(...args, (error, response) => {
    if (error) { err(error); } else { res(response); }
  });
});

const ovh = OVH({
  endpoint: 'ovh-eu',
  appKey: process.env.APP_KEY,
  appSecret: process.env.APP_SECRET,
  consumerKey: process.env.CONSUMER_KEY,
});

// Use an object to allow mutable reference in closures
const domainConfig = {
  current: process.env.DOMAIN
};

const accessRules = [
  { method: 'GET', path: '/me' },
  { method: 'GET', path: '/me/contact/*' },
  { method: 'GET', path: '/email/domain/*' },
  { method: 'POST', path: '/email/domain/*' },
  { method: 'DELETE', path: '/email/domain/*' },
  { method: 'GET', path: '/domain/*' },
  { method: 'POST', path: '/domain/*' },
  { method: 'POST', path: '/auth/credential' },
];

let cache = {};
try {
  const cacheContent = await fs.readFile(`${basePath}/cache.json`, 'utf-8');
  cache = JSON.parse(cacheContent);
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error('Warning: Failed to read cache.json:', err.message);
  }
}

/**
 * Ensure cache for a domain exists
 * @param {string} domainName - Domain name
 */
const ensureCacheForDomain = (domainName) => {
  if (!cache[domainName]) {
    cache[domainName] = {
      redirections: [],
    };
  }
};

ensureCacheForDomain(domainConfig.current);

const getMe = () => ovhRequest('GET', '/me');
// const summary = await ovhRequest('GET', `/email/domain/${domainConfig.current}/summary`);

const redirByFrom = str => cache[domainConfig.current].redirections.find(({ from }) => [str, `${str}@${domainConfig.current}`].includes(from)) || null;

/**
 * Met à jour cache.json en ajoutant les nouvelles redirections,
 * et en en supprimant celles n'existant plus.
 */
const updateRedirections = async () => {
  // Ensure cache structure exists
  ensureCacheForDomain(domainConfig.current);

  const allRedirIds = await ovhRequest('GET', `/email/domain/${domainConfig.current}/redirection`);
  const existingRedirIds = cache[domainConfig.current].redirections.map(({ id }) => id);

  const newRedirIds = allRedirIds.filter(rId => !existingRedirIds.includes(rId));
  const newRedirections = [];

  for (const redirectionId of newRedirIds) {
    try {
      const details = await ovhRequest('GET', `/email/domain/${domainConfig.current}/redirection/${redirectionId}`);
      newRedirections.push(details);
    } catch {
      // Redirection may have been deleted between listing and fetching details
    }
  }

  const deletedRedirIds = existingRedirIds.filter(id => !allRedirIds.includes(id));

  cache[domainConfig.current].redirections = [
    ...cache[domainConfig.current].redirections.filter(({ id }) => !deletedRedirIds.includes(id)),
    ...newRedirections,
  ].sort(({ from: a }, { from: b }) => a.localeCompare(b));

  console.log(`${allRedirIds.length} remote redirection(s)`);
  if (newRedirections.length > 0) {
    console.log(`${newRedirections.length} new redirection(s)`);
  }
  if (deletedRedirIds.length > 0) {
    console.log(`${deletedRedirIds.length} deleted redirection(s)`);
  }

  await fs.writeFile(`${basePath}/cache.json`, JSON.stringify(cache, null, 2));
};

const spamAddress = () => `spam@${domainConfig.current}`;

const prettyMail = str => {
  if (str === spamAddress()) {
    return chalk.red(str);
  }

  const match = str.match(/(.*)@(.*)/);
  if (!match) {
    // Handle truncated or malformed email
    return str;
  }

  const [, left, right] = match;
  return `${left}${chalk.gray(`@${right}`)}`;
};

const listRedirections = (redirections, format = 'table') => {
  const output = formatRedirections(redirections, format);
  console.log(output);
};

const deleteRedir = async (...ids) => {
  for (const id of ids) {
    await ovhRequest('DELETE', `/email/domain/${domainConfig.current}/redirection/${id}`);
    console.log(chalk.green(`Deleted redirection ${id}`));
  }
};

const changeRedir = async (id, to) => {
  if (id && to) {
    await ovhRequest(
      'POST',
      `/email/domain/${domainConfig.current}/redirection/${id}/changeRedirection`,
      { to },
    );
    console.log(chalk.green(`Modified redirection ${id} → ${to}`));
  }
};

/**
 * Retrieve DNS zone information.
 * @param {string} zoneName - The zone domain name
 * @returns {Promise<Object>} - Zone information (name, dnssecSupported, hasDnsAnycast, lastUpdate, nameServers)
 * @throws {Error} - If the API request fails
 */
const getDnsZone = async (zoneName) => {
  const zoneInfo = await ovhRequest('GET', `/domain/zone/${zoneName}`);
  return {
    name: zoneInfo.name || zoneName,
    dnssecSupported: zoneInfo.dnssecSupported || false,
    hasDnsAnycast: zoneInfo.hasDnsAnycast || false,
    lastUpdate: zoneInfo.lastUpdate || 'N/A',
    nameServers: zoneInfo.nameServers ? zoneInfo.nameServers.join(', ') : 'N/A',
  };
};

/**
 * Retrieve DNS records for a zone with their details.
 * @param {string} zoneName - The zone domain name
 * @returns {Promise<Array>} - Array of record objects (id, subDomain, fieldType, target, ttl)
 * @throws {Error} - If the API request fails
 */
const getDnsRecords = async (zoneName) => {
  const recordIds = await ovhRequest('GET', `/domain/zone/${zoneName}/record`);
  if (!recordIds || recordIds.length === 0) {
    return [];
  }
  const recordDetails = await Promise.all(
    recordIds.map(async (recordId) => {
      try {
        const record = await ovhRequest('GET', `/domain/zone/${zoneName}/record/${recordId}`);
        return {
          id: record.id || recordId,
          subDomain: record.subDomain || '@',
          fieldType: record.fieldType || 'N/A',
          target: record.target || 'N/A',
          ttl: record.ttl || 'N/A',
        };
      } catch (err) {
        if (process.env.NODE_ENV === 'development') {
          console.error(`[DEBUG] Failed to fetch record ${recordId}:`, err.message);
        }
        return {
          id: recordId,
          subDomain: 'error',
          fieldType: 'error',
          target: 'error',
          ttl: 'N/A',
        };
      }
    })
  );
  return recordDetails;
};

/**
 * Format a contact identifier for display.
 * For numeric IDs, fetch name and format as "FirstName LastName (ID)".
 * For non-numeric handles, return as-is.
 * @param {string} contactId - Contact ID or account handle
 * @returns {Promise<string>} - Formatted contact string
 */
const formatContactId = async (contactId) => {
  if (!contactId || contactId === 'N/A') {
    return 'N/A';
  }

  // Check if it's a numeric ID (not a handle like 'mb135-ovh')
  if (/^\d+$/.test(contactId)) {
    try {
      const contactInfo = await ovhRequest('GET', `/me/contact/${contactId}`);
      if (contactInfo.firstName && contactInfo.lastName) {
        return `${contactInfo.firstName} ${contactInfo.lastName} (${contactId})`;
      }
      return contactId;
    } catch {
      // If fetch fails, return the ID
      return contactId;
    }
  }

  // Return account handles as-is
  return contactId;
};

/**
 * Retrieve quota usage for the email domain.
 * @returns {Promise<Object>} - Quota object with max and used values
 */
const getQuotaUsage = async () => {
  const [quota, summary] = await Promise.all([
    ovhRequest('GET', `/email/domain/${domainConfig.current}/quota`),
    ovhRequest('GET', `/email/domain/${domainConfig.current}/summary`),
  ]);

  return {
    account: {
      max: quota.account || 0,
      used: summary.account || 0,
    },
    alias: {
      max: quota.alias || 0,
      used: 0, // OVH API DomainSummary does not expose alias count
    },
    mailingList: {
      max: quota.mailingList || 0,
      used: summary.mailingList || 0,
    },
    redirection: {
      max: quota.redirection || 0,
      used: summary.redirection || 0,
    },
    responder: {
      max: quota.responder || 0,
      used: summary.responder || 0,
    },
  };
};

/**
 * Get detailed usage per account.
 * @returns {Promise<Array>} - Array of account usage objects
 */
const getAccountsUsage = async () => {
  try {
    const accounts = await ovhRequest('GET', `/email/domain/${domainConfig.current}/account`);
    if (!accounts || accounts.length === 0) {
      return [];
    }

    const accountsUsage = await Promise.all(
      accounts.map(async (accountName) => {
        try {
          const account = await ovhRequest('GET', `/email/domain/${domainConfig.current}/account/${accountName}`);
          const usage = await ovhRequest('GET', `/email/domain/${domainConfig.current}/account/${accountName}/usage`);

          // Calculate usage percentage safely
          let usagePercent = 'N/A';
          if (usage.quota && usage.quota.max && usage.quota.max > 0) {
            usagePercent = `${((usage.quota.current || 0) / usage.quota.max * 100).toFixed(1)}%`;
          }

          return {
            accountName,
            description: account.description || 'N/A',
            size: account.size || 0,
            email: account.email || 'N/A',
            usage: usagePercent,
            quotaUsed: usage.quota?.current || 0,
            quotaMax: usage.quota?.max || 0,
          };
        } catch (err) {
          if (process.env.NODE_ENV === 'development') {
            console.error(`[DEBUG] Failed to fetch account ${accountName}:`, err.message);
          }
          return {
            accountName,
            description: 'error',
            size: 0,
            email: 'error',
            usage: 'N/A',
            quotaUsed: 0,
            quotaMax: 0,
          };
        }
      })
    );

    return accountsUsage;
  } catch {
    return [];
  }
};

/**
 * Create a progress bar visualization.
 * @param {number} used - Used amount
 * @param {number} max - Maximum amount
 * @param {number} width - Bar width (default: 10)
 * @returns {string} - Progress bar with percentage
 */
const createProgressBar = (used, max, width = 10) => {
  if (!max || max === 0) return '0%    ░░░░░░░░░░';
  const percent = Math.round((used / max) * 100);
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = '▓'.repeat(filled) + '░'.repeat(empty);
  return `${percent.toString().padStart(3)}%  ${bar}`;
};

const createRedir = async (from, to) => {
  if (from && to) {
    await ovhRequest(
      'POST',
      `/email/domain/${domainConfig.current}/redirection`,
      { from, to, localCopy: false },
    );
    console.log(chalk.green(`Created: ${from} → ${to}`));
  }
};

const createDefaultRedir = str => createRedir(
  `${str}@${domainConfig.current}`,
  process.env.DEFAULT_TO.replace(/\{\{alias\}\}/g, str),

);

const program = new Command();

program
  .name('ovh')
  .description('OVH cli manager')
  .option('-d, --domain <domain>', 'Override default domain from .env.local')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    if (opts.domain) {
      domainConfig.current = opts.domain;
      ensureCacheForDomain(domainConfig.current);
    }
  });

program
  .command('auth') // https://www.ovh.com/auth/api/createApp
  .action(async () => console.log(await ovhRequest('POST', '/auth/credential', { accessRules })));

const redir = program
  .command('redir')
  .description('Manage redirections');

redir
  .command('list')
  .description('List all cached redirections')
  .option('-u, --update', 'Update before displaying redirections')
  .option('--no-spam', 'Hide spam redirections')
  .option('--noplus', 'Hide DEFAULT_TO-pattern redirections (implies --no-spam)')
  .option('-f, --format <format>', 'Output format: table, json, or csv (default: table)')
  .option('-s, --sort <column>', 'Sort by column: from, to, or id (default: from)')
  .option('-r, --reverse', 'Reverse sort order')
  .option('-q, --search <query>', 'Filter results by search query')
  .action(async ({ update, spam, noplus, format, sort, reverse, search }) => {
    if (update) {
      await updateRedirections();
    }
    let results = cache[domainConfig.current].redirections;
    // Apply spam filter
    if (!spam) {
      results = results.filter(({ to }) => to !== spamAddress());
    }
    // Apply noplus filter (implies spam filter)
    if (noplus) {
      results = results.filter(({ to }) => to !== spamAddress());
      if (process.env.DEFAULT_TO) {
        const plusPattern = new RegExp(
          '^' + process.env.DEFAULT_TO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{\\{alias\\}\\}', '.+') + '$'
        );
        results = results.filter(({ to }) => !plusPattern.test(to));
      }
    }
    // Apply search filter
    if (search) {
      results = filterRedirections(results, search);
    }
    // Apply sorting
    const sortOrder = reverse ? 'desc' : 'asc';
    results = sortRedirections(results, sort || 'from', sortOrder);
    // Display results
    listRedirections(results, format);
  });

redir
  .command('update')
  .description('Update cached redirections')
  .action(updateRedirections);

redir
  .command('ban <localPart...>')
  .description(`Create redirections localPart@<domain> to spam@<domain>`)
  .action(async localParts => {
    for (const localPart of localParts) {
      await createRedir(`${localPart}@${domainConfig.current}`, spamAddress());
    }
    await updateRedirections();
  });

redir
  .command('create')
  .description('Create a new redirection')
  .argument('<from>')
  .argument('[to]')
  .action(async (from, to) => {
    try {
      // Check if 'from' contains the domain when it shouldn't
      if (from && from.includes('@')) {
        const fromDomain = from.split('@')[1];
        if (fromDomain === domainConfig.current) {
          const localPart = from.split('@')[0];
          console.error(chalk.yellow(`⚠️  You provided a full email address with domain: ${chalk.bold(from)}`));
          console.error(chalk.yellow(`    For this command, only the local part is needed.\n`));

          // Interactive prompt using simple stdin read
          const readline = await import('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          const answer = await new Promise((resolve) => {
            rl.question(
              chalk.cyan(`Do you want to create redirection for "${chalk.bold(localPart)}" instead? (y/N): `),
              (ans) => {
                rl.close();
                resolve(ans);
              }
            );
          });

          if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
            from = localPart;
            console.log(chalk.green(`✓ Using local part: ${localPart}\n`));
          } else {
            console.log(chalk.gray('Operation cancelled.'));
            return;
          }
        }
      }

      const fromSanitized = validateCliArg(from, 'localOrEmail');
      const toSanitized = to ? validateCliArg(to, 'email') : undefined;

      if (!to && !process.env.DEFAULT_TO) {
        console.error(chalk.red('Error: No destination specified and DEFAULT_TO not configured.'));
        console.error(chalk.gray('Either provide a destination email or configure DEFAULT_TO in .env.local'));
        return;
      }

      // Ensure from is a full email address
      const fromEmail = fromSanitized.includes('@') ? fromSanitized : `${fromSanitized}@${domainConfig.current}`;

      if (toSanitized) {
        await createRedir(fromEmail, toSanitized);
      } else {
        await createDefaultRedir(fromSanitized);
      }
      await updateRedirections();
    } catch (err) {
      console.error(chalk.red('Error creating redirection:'), err.message || err);
      if (process.env.NODE_ENV === 'development') {
        console.error('[DEBUG]', err);
      }
    }
  });

redir
  .command('delete')
  .description('Delete an existing redirection')
  .argument('<from...>')
  .action(async items => {
    try {
      // Ensure cache exists
      ensureCacheForDomain(domainConfig.current);

      for (const item of items) {
        try {
          const isId = /^\d+$/.test(item);
          const sanitized = isId
          ? validateCliArg(item, 'id')
          : validateCliArg(item, 'localOrEmail');
          const redirId = isId ? sanitized : redirByFrom(sanitized)?.id;
          if (!redirId) {
            console.error(`Redirection "${item}" not found. Run "ovh redir update" to refresh the cache.`);
            continue;
          }
          await deleteRedir(redirId);
        } catch (err) {
          console.error(`Failed to delete "${item}":`, err.message || err);
          if (process.env.NODE_ENV === 'development') {
            console.error('[DEBUG]', err);
          }
        }
      }
      await updateRedirections();
    } catch (err) {
      console.error('Unexpected error:', err.message || err);
      if (process.env.NODE_ENV === 'development') {
        console.error('[DEBUG]', err);
      }
    }
  });

redir
  .command('modify')
  .description('Modify the destination of an existing redirection')
  .argument('<source>')
  .argument('<newTo>')
  .action(async (source, newTo) => {
    try {
      // Determine if source is an ID or email/local part
      const isId = /^\d+$/.test(source);
      const sanitizedSource = isId
        ? validateCliArg(source, 'id')
        : validateCliArg(source, 'localOrEmail');
      const sanitizedTo = validateCliArg(newTo, 'email');

      // Find the redirection ID
      const redirId = isId ? sanitizedSource : redirByFrom(sanitizedSource)?.id;

      if (!redirId) {
        console.error(`No redirection found for "${source}". Run "ovh redir update" to refresh the cache.`);
        return;
      }

      await changeRedir(redirId, sanitizedTo);

      // Ensure cache exists before update
      ensureCacheForDomain(domainConfig.current);

      // Update cache
      await updateRedirections();
    } catch (err) {
      console.error('Failed to modify redirection:', err.message || err);
      if (process.env.NODE_ENV === 'development') {
        console.error('[DEBUG]', err);
      }
    }
  });

redir
  .command('task')
  .description('List pending redirection tasks')
  .option('-f, --format <format>', 'Output format: table, json, or csv')
  .action(async ({ format }) => {
    try {
      const taskIds = await ovhRequest('GET', `/email/domain/${domainConfig.current}/task/redirection`);
      if (!taskIds || taskIds.length === 0) {
        console.log('No pending tasks.');
        return;
      }
      const tasks = await Promise.all(
        taskIds.map(async (id) => {
          try {
            return await ovhRequest('GET', `/email/domain/${domainConfig.current}/task/redirection/${id}`);
          } catch (err) {
            if (process.env.NODE_ENV === 'development') {
              console.error(`[DEBUG] Failed to fetch task ${id}:`, err.message);
            }
            return { id, action: 'error', account: 'error' };
          }
        })
      );
      console.log(formatOutput(tasks, format));
    } catch (err) {
      console.error('Failed to list redirection tasks:', err.message);
    }
  });

program
  .command('status')
  .description('Account informations')
  .action(async () => console.log(await getMe()));

program
  .command('quota')
  .description('Display quota usage for the email domain')
  .option('-p, --per-account', 'Show usage per account')
  .option('-s, --summary', 'Show compact summary format (used/max)')
  .option('--simple', 'Show simple max values only')
  .option('-f, --format <format>', 'Output format: table, json, or csv (default: table)')
  .action(async (options) => {
    try {
      const { perAccount: perAccountOpt, summary, simple, format } = options;

      // Per-account view
      if (perAccountOpt) {
        const accountsUsage = await getAccountsUsage();
        if (accountsUsage.length === 0) {
          console.log('No accounts found.');
          return;
        }
        const output = formatOutput(accountsUsage, format, ['accountName', 'description', 'usage']);
        console.log(output);
        return;
      }

      const quotaData = await getQuotaUsage();

      const resources = [
        { key: 'account', label: 'Mailboxes' },
        { key: 'alias', label: 'Aliases' },
        { key: 'mailingList', label: 'Mailing Lists' },
        { key: 'redirection', label: 'Redirections' },
        { key: 'responder', label: 'Responders' },
      ];

      let data;
      let columns;

      if (simple) {
        data = resources.map(({ key, label }) => ({
          resource: label,
          max: quotaData[key].max,
        }));
        columns = ['resource', 'max'];
      } else if (summary) {
        data = resources.map(({ key, label }) => ({
          resource: label,
          usage: `${quotaData[key].used}/${quotaData[key].max}`,
        }));
        columns = ['resource', 'usage'];
      } else {
        data = resources.map(({ key, label }) => ({
          type: label,
          used: quotaData[key].used,
          max: quotaData[key].max,
          progress: createProgressBar(quotaData[key].used, quotaData[key].max),
        }));
        columns = ['type', 'used', 'max', 'progress'];
      }

      console.log(formatOutput(data, format, columns));
    } catch (err) {
      console.error('Failed to retrieve quota information:', err.message);
    }
  });

const domainCmd = program
  .command('domain')
  .description('Manage domain services');

domainCmd
  .command('list')
  .description('List all accessible domains')
  .option('-f, --format <format>', 'Output format: table, json, or csv (default: table)')
  .action(async ({ format }) => {
    try {
      const domains = await ovhRequest('GET', '/domain');
      if (!domains || domains.length === 0) {
        console.log('No domains found.');
        return;
      }
      // Fetch detailed info for each domain
      const domainDetails = await Promise.all(
        domains.map(async (domainName) => {
          try {
            const info = await ovhRequest('GET', `/domain/${domainName}`);
            return {
              name: domainName,
              status: info.state || 'unknown',
              ownerContact: info.ownerContact || 'N/A',
              expirationDate: info.expirationDate || 'N/A',
            };
          } catch (err) {
            if (process.env.NODE_ENV === 'development') {
              console.error(`[DEBUG] Failed to fetch domain ${domainName}:`, err.message);
            }
            return {
              name: domainName,
              status: 'error',
              ownerContact: 'N/A',
              expirationDate: 'N/A',
            };
          }
        })
      );
      // Format output
      const output = formatOutput(domainDetails, format);
      console.log(output);
    } catch (err) {
      console.error('Failed to list domains:', err.message);
    }
  });

domainCmd
  .command('contacts:list <domainName>')
  .description('List all contacts for a domain')
  .option('-f, --format <format>', 'Output format: table, json, or csv (default: table)')
  .action(async (domainName, { format }) => {
    try {
      const response = await ovhRequest('GET', `/domain/${domainName}`);

      // Fetch formatted contact names asynchronously
      const [adminFormatted, billingFormatted, ownerFormatted, techFormatted] = await Promise.all([
        formatContactId(response.contactAdmin?.id),
        formatContactId(response.contactBilling?.id),
        formatContactId(response.contactOwner?.id),
        formatContactId(response.contactTech?.id),
      ]);

      const contactInfo = {
        Admin: adminFormatted,
        Billing: billingFormatted,
        Owner: ownerFormatted,
        Tech: techFormatted,
      };

      const output = formatOutput([contactInfo], format);
      console.log(output);
    } catch (err) {
      console.error('Failed to list contacts:', err.message);
    }
  });

domainCmd
  .command('dns:list <domainName>')
  .description('List nameservers for a domain')
  .option('-f, --format <format>', 'Output format: table, json, or csv (default: table)')
  .action(async (domainName, { format }) => {
    try {
      const nameServers = await ovhRequest('GET', `/domain/${domainName}/nameServer`);
      if (!nameServers || nameServers.length === 0) {
        console.log('No nameservers found.');
        return;
      }
      const nsDetails = await Promise.all(
        nameServers.map(async (nsId) => {
          try {
            const nsInfo = await ovhRequest('GET', `/domain/${domainName}/nameServer/${nsId}`);
            return {
              id: nsId,
              host: nsInfo.host || 'N/A',
              ip: nsInfo.ip || 'N/A',
            };
          } catch (err) {
            if (process.env.NODE_ENV === 'development') {
              console.error(`[DEBUG] Failed to fetch nameserver ${nsId}:`, err.message);
            }
            return {
              id: nsId,
              host: 'error',
              ip: 'N/A',
            };
          }
        })
      );
      const output = formatOutput(nsDetails, format);
      console.log(output);
    } catch (err) {
      console.error('Failed to list nameservers:', err.message);
    }
  });

domainCmd
  .command('zone:info <zoneName>')
  .description('Display DNS zone information')
  .option('-f, --format <format>', 'Output format: table, json, or csv (default: table)')
  .action(async (zoneName, { format }) => {
    try {
      const zoneInfo = await getDnsZone(zoneName);
      const output = formatOutput([zoneInfo], format);
      console.log(output);
    } catch (err) {
      console.error('Failed to retrieve zone information:', err.message);
    }
  });

domainCmd
  .command('zone:records <zoneName>')
  .description('List all DNS records for a zone')
  .option('-f, --format <format>', 'Output format: table, json, or csv (default: table)')
  .option('--filter <type>', 'Filter records by type (e.g., A, MX, CNAME, TXT)')
  .action(async (zoneName, { format, filter }) => {
    try {
      let records = await getDnsRecords(zoneName);
      if (!records || records.length === 0) {
        console.log('No records found.');
        return;
      }
      // Apply type filter if specified
      if (filter) {
        records = records.filter(({ fieldType }) =>
          fieldType.toUpperCase() === filter.toUpperCase()
        );
        if (records.length === 0) {
          console.log(`No records found for type: ${filter}`);
          return;
        }
      }
      const output = formatOutput(records, format);
      console.log(output);
    } catch (err) {
      console.error('Failed to list zone records:', err.message);
    }
  });

domainCmd
  .command('zone:export <zoneName>')
  .description('Export DNS zone as BIND zone file')
  .action(async (zoneName) => {
    try {
      const zoneFile = await ovhRequest('GET', `/domain/zone/${zoneName}/export`);
      console.log(zoneFile);
    } catch (err) {
      console.error('Failed to export zone:', err.message);
    }
  });

domainCmd
  .command('zone:refresh <zoneName>')
  .description('Apply pending DNS zone changes')
  .action(async (zoneName) => {
    try {
      await ovhRequest('POST', `/domain/zone/${zoneName}/refresh`);
      console.log(chalk.green(`Zone ${zoneName} refreshed`));
    } catch (err) {
      console.error('Failed to refresh zone:', err.message);
    }
  });

domainCmd
  .command('zone:status <zoneName>')
  .description('Display DNS zone deployment status')
  .option('-f, --format <format>', 'Output format: table, json, or csv')
  .action(async (zoneName, { format }) => {
    try {
      const status = await ovhRequest('GET', `/domain/zone/${zoneName}/status`);
      console.log(formatOutput([status], format));
    } catch (err) {
      console.error('Failed to retrieve zone status:', err.message);
    }
  });

domainCmd
  .command('zone:soa <zoneName>')
  .description('Display DNS zone SOA record')
  .option('-f, --format <format>', 'Output format: table, json, or csv')
  .action(async (zoneName, { format }) => {
    try {
      const soa = await ovhRequest('GET', `/domain/zone/${zoneName}/soa`);
      console.log(formatOutput([soa], format));
    } catch (err) {
      console.error('Failed to retrieve SOA record:', err.message);
    }
  });

domainCmd
  .command('mx')
  .description('Display MX records for the email domain')
  .option('-f, --format <format>', 'Output format: table, json, or csv')
  .action(async ({ format }) => {
    try {
      const records = await ovhRequest('GET', `/email/domain/${domainConfig.current}/dnsMXRecords`);
      if (!records || records.length === 0) {
        console.log('No MX records found.');
        return;
      }
      const data = records.map((target, i) => ({ priority: i + 1, target }));
      console.log(formatOutput(data, format));
    } catch (err) {
      console.error('Failed to retrieve MX records:', err.message);
    }
  });

domainCmd
  .command('dkim')
  .description('Display DKIM configuration for the email domain')
  .option('-f, --format <format>', 'Output format: table, json, or csv')
  .action(async ({ format }) => {
    try {
      const dkim = await ovhRequest('GET', `/email/domain/${domainConfig.current}/dkim`);
      if (format === 'json') {
        console.log(JSON.stringify(dkim, null, 2));
        return;
      }
      console.log(`Status: ${dkim.status || 'N/A'}`);
      console.log(`Active selector: ${dkim.activeSelector || 'none'}`);
      console.log(`Autoconfig: ${dkim.autoconfig ?? 'N/A'}`);
      if (dkim.selectors && dkim.selectors.length > 0) {
        console.log('');
        console.log(formatOutput(dkim.selectors, format));
      }
    } catch (err) {
      console.error('Failed to retrieve DKIM status:', err.message);
    }
  });

domainCmd
  .command('dns:recommended')
  .description('Display recommended DNS records for the email domain')
  .option('-f, --format <format>', 'Output format: table, json, or csv')
  .action(async ({ format }) => {
    try {
      const records = await ovhRequest('GET', `/email/domain/${domainConfig.current}/recommendedDNSRecords`);
      if (!records || records.length === 0) {
        console.log('No recommended records.');
        return;
      }
      console.log(formatOutput(records, format));
    } catch (err) {
      console.error('Failed to retrieve recommended DNS records:', err.message);
    }
  });

const BASH_COMPLETION = `_ovh_completions() {
  local cur prev words cword
  _init_completion || return

  local commands="auth redir status quota domain completion"
  local redir_cmds="list update ban create delete modify"
  local domain_cmds="list contacts:list dns:list zone:info zone:records"

  case "\${cword}" in
    1)
      COMPREPLY=( \$(compgen -W "\${commands}" -- "\${cur}") )
      return
      ;;
    2)
      case "\${prev}" in
        redir)
          COMPREPLY=( \$(compgen -W "\${redir_cmds}" -- "\${cur}") )
          return
          ;;
        domain)
          COMPREPLY=( \$(compgen -W "\${domain_cmds}" -- "\${cur}") )
          return
          ;;
        completion)
          COMPREPLY=( \$(compgen -W "--shell" -- "\${cur}") )
          return
          ;;
      esac
      ;;
  esac

  # Option value completions
  case "\${prev}" in
    --format|-f)
      COMPREPLY=( \$(compgen -W "table json csv" -- "\${cur}") )
      return
      ;;
    --sort|-s)
      COMPREPLY=( \$(compgen -W "from to id" -- "\${cur}") )
      return
      ;;
    --shell)
      COMPREPLY=( \$(compgen -W "bash zsh" -- "\${cur}") )
      return
      ;;
    --domain|-d)
      return
      ;;
  esac

  # Context-sensitive option completions
  local subcmd=""
  local i
  for (( i=1; i < cword; i++ )); do
    case "\${words[i]}" in
      redir|domain) subcmd="\${words[i]}:\${words[i+1]}"; break ;;
      auth|status|quota|completion) subcmd="\${words[i]}"; break ;;
    esac
  done

  if [[ "\${cur}" == -* ]]; then
    local opts=""
    case "\${subcmd}" in
      redir:list)     opts="--update --no-spam --noplus --format --sort --reverse --search --help" ;;
      redir:ban)      opts="--help" ;;
      redir:create)   opts="--help" ;;
      redir:delete)   opts="--help" ;;
      redir:modify)   opts="--help" ;;
      redir:update)   opts="--help" ;;
      quota)          opts="--per-account --summary --simple --format --help" ;;
      domain:list)    opts="--format --help" ;;
      domain:contacts:list) opts="--format --help" ;;
      domain:dns:list)      opts="--format --help" ;;
      domain:zone:info)     opts="--format --help" ;;
      domain:zone:records)  opts="--format --filter --help" ;;
      completion)     opts="--shell --help" ;;
    esac
    COMPREPLY=( \$(compgen -W "\${opts}" -- "\${cur}") )
  fi
}

complete -F _ovh_completions ovh
`;

const ZSH_COMPLETION = `#compdef ovh

_ovh() {
  local -a commands redir_cmds domain_cmds formats sort_cols shells

  commands=(
    'auth:Authenticate with OVH API'
    'redir:Manage redirections'
    'status:Account informations'
    'quota:Display quota usage for the email domain'
    'domain:Manage domain services'
    'completion:Generate shell completion script'
  )

  redir_cmds=(
    'list:List all cached redirections'
    'update:Update cached redirections'
    'ban:Create redirections to spam'
    'create:Create a new redirection'
    'delete:Delete an existing redirection'
    'modify:Modify the destination of an existing redirection'
  )

  domain_cmds=(
    'list:List all accessible domains'
    'contacts\\:list:List all contacts for a domain'
    'dns\\:list:List nameservers for a domain'
    'zone\\:info:Display DNS zone information'
    'zone\\:records:List all DNS records for a zone'
  )

  formats=(table json csv)
  sort_cols=(from to id)
  shells=(bash zsh)

  _arguments -C \\
    '(-d --domain)'{-d,--domain}'[Override default domain]:domain:' \\
    '--help[Show help]' \\
    '--version[Show version]' \\
    '1:command:->cmds' \\
    '*::arg:->args'

  case "\$state" in
    cmds)
      _describe -t commands 'ovh command' commands
      ;;
    args)
      case "\${words[1]}" in
        redir)
          _arguments -C \\
            '1:subcommand:->redir_cmds' \\
            '*::arg:->redir_args'
          case "\$state" in
            redir_cmds)
              _describe -t commands 'redir subcommand' redir_cmds
              ;;
            redir_args)
              case "\${words[1]}" in
                list)
                  _arguments \\
                    '(-u --update)'{-u,--update}'[Update before displaying]' \\
                    '--no-spam[Hide spam redirections]' \\
                    '--noplus[Hide DEFAULT_TO-pattern redirections]' \\
                    '(-f --format)'{-f,--format}'[Output format]:format:(table json csv)' \\
                    '(-s --sort)'{-s,--sort}'[Sort by column]:column:(from to id)' \\
                    '(-r --reverse)'{-r,--reverse}'[Reverse sort order]' \\
                    '(-q --search)'{-q,--search}'[Filter results by search query]:query:'
                  ;;
                ban)
                  _arguments '*:localPart:'
                  ;;
                create)
                  _arguments '1:from:' '2:to:'
                  ;;
                delete)
                  _arguments '*:from:'
                  ;;
                modify)
                  _arguments '1:source:' '2:newTo:'
                  ;;
              esac
              ;;
          esac
          ;;
        domain)
          _arguments -C \\
            '1:subcommand:->domain_cmds' \\
            '*::arg:->domain_args'
          case "\$state" in
            domain_cmds)
              _describe -t commands 'domain subcommand' domain_cmds
              ;;
            domain_args)
              case "\${words[1]}" in
                list)
                  _arguments '(-f --format)'{-f,--format}'[Output format]:format:(table json csv)'
                  ;;
                contacts:list|dns:list|zone:info)
                  _arguments \\
                    '1:domainName:' \\
                    '(-f --format)'{-f,--format}'[Output format]:format:(table json csv)'
                  ;;
                zone:records)
                  _arguments \\
                    '1:zoneName:' \\
                    '(-f --format)'{-f,--format}'[Output format]:format:(table json csv)' \\
                    '--filter[Filter records by type]:type:(A AAAA MX CNAME TXT SRV NS SOA PTR)'
                  ;;
              esac
              ;;
          esac
          ;;
        quota)
          _arguments \\
            '(-p --per-account)'{-p,--per-account}'[Show usage per account]' \\
            '(-s --summary)'{-s,--summary}'[Show compact summary format]' \\
            '--simple[Show simple max values only]' \\
            '(-f --format)'{-f,--format}'[Output format]:format:(table json csv)'
          ;;
        completion)
          _arguments \\
            '--shell[Shell type]:shell:(bash zsh)'
          ;;
      esac
      ;;
  esac
}

_ovh "\$@"
`;

program
  .command('completion')
  .description('Generate shell completion script')
  .requiredOption('--shell <type>', 'Shell type (bash or zsh)')
  .action((opts) => {
    const scripts = { bash: BASH_COMPLETION, zsh: ZSH_COMPLETION };
    const script = scripts[opts.shell];
    if (!script) {
      console.error(`Unsupported shell: ${opts.shell}. Supported: bash, zsh`);
      process.exitCode = 1;
      return;
    }
    console.log(script);
  });

program.parse();

// Global error handling for unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason) => {
  // Never log secrets or sensitive data
  console.error('\nAn error occurred. Please try again later.');
  // Technical details for devs (filtered)
  if (process.env.NODE_ENV === 'development') {
    console.error('[DEBUG] Technical detail (unhandledRejection):', maskSecretsInLog(reason));
  }
});

process.on('uncaughtException', (err) => {
  // Never log secrets or sensitive data
  console.error('\nA critical error occurred. Please try again later.');
  // Technical details for devs (filtered)
  if (process.env.NODE_ENV === 'development') {
    console.error('[DEBUG] Technical detail (uncaughtException):', maskSecretsInLog(err));
  }
});
