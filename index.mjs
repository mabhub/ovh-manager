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
  cache = JSON.parse(await fs.readFile(`${basePath}/cache.json`));
} catch (err) {
  console.error(err);
}
if (!cache[domain]) {
  cache[domain] = {
    redirections: [],
  };
}

const getMe = () => ovhRequest('GET', '/me');
const summary = await ovhRequest('GET', `/email/domain/${domain}/summary`);

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

  const { 0: full, 1: left, 2: right } = str.match(/(.*)@(.*)/);
  return `${left}${chalk.gray(`@${right}`)}`;
};

const listRedirections = async (filterFn = () => true) => {
  const output = new Table({
    head: ['id', 'from', 'to'],
  });

  output.push(...cache[domain].redirections
    .filter(filterFn)
    .map(({ id, from, to }) => [
      chalk.gray(id),
      { content: prettyMail(from), hAlign: 'right' },
      { content: prettyMail(to), hAlign: 'right' },
    ]));

  console.log(output.toString());
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
  .option('-s, --no-spam', 'Hide spam reidrections')
  .action(async ({ update, spam }) => {
    update && await updateRedirections();
    await listRedirections(({ to }) => spam || to !== `spam@${domain}`);
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
    if (to) {
      await createRedir(from, to);
    } else {
      await createDefaultRedir(from);
    }

    await updateRedirections();
  });

redir
  .command('delete')
  .description('Delete an existing redirection')
  .argument('<from...>')
  .action(async items => {
    for await (const item of items) {
      const isId = Number(item).toString() === item;
      await deleteRedir(isId ? item : redirByFrom(item).id);
    }
    await updateRedirections();
  });

program
  .command('status')
  .description('Account informations')
  .action(async () => console.log(await getMe()));

program
  .command('quota')
  .action(async () => console.log(await ovhRequest('GET', `/email/domain/${domain}/account`)));

program.parse();
