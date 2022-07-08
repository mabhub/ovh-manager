#!/bin/sh
//bin/false || export NVM_DIR="$HOME/.nvm"
//bin/false || [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
//bin/false || nvm use 18
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

const cache = JSON.parse(await fs.readFile(`${basePath}/cache.json`));

const authorize = () => ovhRequest('POST', '/auth/credential', { accessRules })
const getMe = () => ovhRequest('GET', '/me');
const summary = await ovhRequest('GET', `/email/domain/${domain}/summary`);

const redirByFrom = str => cache.redirections.find(({ from }) => [str, `${str}@${domain}`].includes(from)) || {};

/**
 * Met à jour cache.json en ajoutant les nouvelles redirections,
 * et en en supprimant celles n'existant plus.
 */
const updateRedirections = async () => {
  const allRedirIds = await ovhRequest('GET', `/email/domain/${domain}/redirection`);
  const existingRedirIds = cache.redirections.map(({ id }) => id);

  const newRedirIds = allRedirIds.filter(rId => !existingRedirIds.includes(rId));
  const newRedirections = [];

  for await (const redirectionId of newRedirIds) {
    const details = await ovhRequest('GET', `/email/domain/${domain}/redirection/${redirectionId}`);
    newRedirections.push(details);
  }

  const deletedRedirIds = existingRedirIds.filter(id => !allRedirIds.includes(id));

  cache.redirections = [
    ...cache.redirections
      .sort(({ from: a }, { from: b }) => a.localeCompare(b))
      .filter(({ id }) => !deletedRedirIds.includes(id)),
    ...newRedirections,
  ];

  console.log(`${newRedirections.length} new redirection(s)`);
  console.log(`${deletedRedirIds.length} deleted redirection(s)`);

  await fs.writeFile(`${basePath}/cache.json`, JSON.stringify(cache, null, 2));
};

const prettyMail = str => {
  if (str === 'spam@${domain}') {
    return chalk.red(str);
  }

  const { 0: full, 1: left, 2: right } = str.match(/(.*)@(.*)/);
  return `${left}${chalk.gray(`@${right}`)}`;
};

const listRedirections = async () => {
  const output = new Table({
    head: ['id', 'from', 'to'],
  });

  output.push(...cache.redirections
    // .filter(({ }))
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

const redir = async (action, args, options) => {
  const [from, to] = args;

  if (options.update) {
    await updateRedirections();
  }

  switch (action) {
    case 'create': {
      if (!args.length) {
        return;
      }

      if (args.length === 1) {
        await createDefaultRedir(from);
      }

      if (args.length === 2) {
        await createRedir(from, to);
      }

      break;
    }

    case 'ban': {
      if (from) {
        await createRedir(`${from}@${domain}`, `spam@${domain}`);
      }
      break;
    }

    case 'update': {
      await updateRedirections();
      break;
    }

    case 'list': {
      await listRedirections();
      break;
    }

    case 'del':
    case 'delete':
    case 'rm':
    case 'remove': {
      await deleteRedir(...args);
      break;
    }

    case 'change': {
      if (from && to) {
        await changeRedir(redirByFrom(from).id, to);
      }
      break;
    }
  }

};

const status = async () => {
  console.log(await getMe());
};

const program = new Command();

program
  .name('ovh');

program
  .command('redir <action> [arguments...]')
  .description('Manage redirections')
  .option('-u , --update', 'Update data before action')
  .action(redir);

program
  .command('status')
  .description('Account informations')
  .action(status);

program.parse();
