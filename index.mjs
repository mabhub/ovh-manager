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
      cols.map(col => `"${item[col] || 'N/A'}"`)
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
      `"${id}"`,
      `"${from}"`,
      `"${to}"`,
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

const domain = process.env.DOMAIN;

const accessRules = [
  { 'method': 'GET', 'path': '/*'},
  { 'method': 'POST', 'path': '/*'},
  { 'method': 'PUT', 'path': '/*'},
  { 'method': 'DELETE', 'path': '/*'}
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
if (!cache[domain]) {
  cache[domain] = {
    redirections: [],
  };
}

const getMe = () => ovhRequest('GET', '/me');
// const summary = await ovhRequest('GET', `/email/domain/${domain}/summary`);

const redirByFrom = str => cache[domain].redirections.find(({ from }) => [str, `${str}@${domain}`].includes(from)) || {};

/**
 * Met à jour cache.json en ajoutant les nouvelles redirections,
 * et en en supprimant celles n'existant plus.
 */
const updateRedirections = async () => {
  const allRedirIds = await ovhRequest('GET', `/email/domain/${domain}/redirection`);
  const existingRedirIds = cache[domain].redirections.map(({ id }) => id);

  const newRedirIds = allRedirIds.filter(rId => !existingRedirIds.includes(rId));
  const newRedirections = [];

  for await (const redirectionId of newRedirIds) {
    const details = await ovhRequest('GET', `/email/domain/${domain}/redirection/${redirectionId}`);
    newRedirections.push(details);
  }

  const deletedRedirIds = existingRedirIds.filter(id => !allRedirIds.includes(id));

  cache[domain].redirections = [
    ...cache[domain].redirections.filter(({ id }) => !deletedRedirIds.includes(id)),
    ...newRedirections,
  ].sort(({ from: a }, { from: b }) => a.localeCompare(b));

  console.log(`${existingRedirIds.length} remote redirection(s)`);
  console.log(`${newRedirections.length} new redirection(s)`);
  console.log(`${deletedRedirIds.length} deleted redirection(s)`);

  await fs.writeFile(`${basePath}/cache.json`, JSON.stringify(cache, null, 2));
};

const prettyMail = str => {
  if (str === `spam@${domain}`) {
    return chalk.red(str);
  }

  const match = str.match(/(.*)@(.*)/);
  if (!match) {
    // Handle truncated or malformed email
    return str;
  }

  const { 0: _full, 1: left, 2: right } = match;
  return `${left}${chalk.gray(`@${right}`)}`;
};

const listRedirections = (redirections, format = 'table') => {
  const output = formatRedirections(redirections, format);
  console.log(output);
};

const deleteRedir = async (...ids) => {
  if (ids && ids.length) {
    for await (const id of ids) {
      await ovhRequest('DELETE', `/email/domain/${domain}/redirection/${id}`);
    }
  }
};

const changeRedir = async (id, to) => {
  if (id && to) {
    const response = await ovhRequest(
      'POST',
      `/email/domain/${domain}/redirection/${id}/changeRedirection`,
      { to },
    );
    console.log(response);
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
      } catch {
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

const createRedir = async (from, to) => {
  if (from && to) {
    const response = await ovhRequest(
      'POST',
      `/email/domain/${domain}/redirection`,
      { from, to, localCopy: false },
    );
    console.log(response);
  }
};

const createDefaultRedir = str => createRedir(
  `${str}@${domain}`,
  process.env.DEFAULT_TO.replace(/\{\{alias\}\}/g, str),

);

const program = new Command();

program
  .name('ovh')
  .description('OVH cli manager');

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
  .option('-f, --format <format>', 'Output format: table, json, or csv (default: table)')
  .option('-s, --sort <column>', 'Sort by column: from, to, or id (default: from)')
  .option('-r, --reverse', 'Reverse sort order')
  .option('-q, --search <query>', 'Filter results by search query')
  .action(async ({ update, spam, format, sort, reverse, search }) => {
    if (update) {
      await updateRedirections();
    }
    let results = cache[domain].redirections;
    // Apply spam filter
    if (spam) {
      results = results.filter(({ to }) => to !== `spam@${domain}`);
    }
    // Apply search filter
    if (search) {
      results = filterRedirections(results, search);
    }
    // Apply sorting
    const sortOrder = reverse ? 'desc' : 'asc';
    results = sortRedirections(results, sort || 'from', sortOrder);
    // Display results
    listRedirections(results, format || 'table');
  });

redir
  .command('update')
  .description('Update cached redirections')
  .action(updateRedirections);

redir
  .command('ban <localPart...>')
  .description(`Create redirections localPart@${domain} to spam@${domain}`)
  .action(async localParts => {
    for await (const localPart of localParts) {
      await createRedir(`${localPart}@${domain}`, `spam@${domain}`);
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
      const fromSanitized = validateCliArg(from, 'localOrEmail');
      const toSanitized = to ? validateCliArg(to, 'email') : undefined;
      if (toSanitized) {
        await createRedir(fromSanitized, toSanitized);
      } else {
        await createDefaultRedir(fromSanitized);
      }
      await updateRedirections();
    } catch (err) {
      console.error('Invalid argument:', err.message);
    }
  });

redir
  .command('delete')
  .description('Delete an existing redirection')
  .argument('<from...>')
  .action(async items => {
    try {
      for await (const item of items) {
        try {
          const isId = Number(item).toString() === item;
          const sanitized = isId
          ? validateCliArg(item, 'id')
          : validateCliArg(item, 'localOrEmail');
          await deleteRedir(isId ? sanitized : redirByFrom(sanitized).id);
        } catch (err) {
          console.error(`Failed to delete "${item}":`, err.message);
        }
      }
      await updateRedirections();
    } catch (err) {
      console.error('Unexpected error:', err.message);
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
      const isId = Number(source).toString() === source;
      const sanitizedSource = isId
        ? validateCliArg(source, 'id')
        : validateCliArg(source, 'localOrEmail');
      const sanitizedTo = validateCliArg(newTo, 'email');

      // Find the redirection ID
      const redirId = isId ? sanitizedSource : redirByFrom(sanitizedSource).id;

      if (!redirId) {
        console.error(`No redirection found for "${source}".`);
        return;
      }

      // Perform the modification
      await changeRedir(redirId, sanitizedTo);
      console.log(`Redirection modified: ID ${redirId} → ${sanitizedTo}`);

      // Update cache
      await updateRedirections();
    } catch (err) {
      console.error('Failed to modify redirection:', err.message);
    }
  });

program
  .command('status')
  .description('Account informations')
  .action(async () => console.log(await getMe()));

program
  .command('quota')
  .action(async () => console.log(await ovhRequest('GET', `/email/domain/${domain}/account`)));

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
          } catch {
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
      const output = formatOutput(domainDetails, format || 'table');
      console.log(output);
    } catch (err) {
      console.error('Failed to list domains:', err.message);
    }
  });

domainCmd
  .command('contacts <_domainName>')
  .description('Manage contacts for a domain')
  .action(() => {
    // This will be handled by subcommands
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

      const output = formatOutput([contactInfo], format || 'table');
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
          } catch {
            return {
              id: nsId,
              host: 'error',
              ip: 'N/A',
            };
          }
        })
      );
      const output = formatOutput(nsDetails, format || 'table');
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
      const output = formatOutput([zoneInfo], format || 'table');
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
      const output = formatOutput(records, format || 'table');
      console.log(output);
    } catch (err) {
      console.error('Failed to list zone records:', err.message);
    }
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
